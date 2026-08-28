/**
 * The composer's local draft mirror (plan idea 7).
 *
 * Autosave is server-only on a 1.5s debounce, so a tab crash, a killed browser
 * or a device that dropped off the network loses every keystroke since the last
 * `drafts.update`. This mirrors the live compose fields into the existing
 * on-device store on a much shorter debounce and, on reopen, offers them back
 * as a "Restore unsaved changes" bar.
 *
 * Four lifecycle facts it has to get right:
 *
 *  - RECONCILE ONCE, ON OPEN. A reopened draft is reconciled the moment the
 *    server row has been hydrated in (`lastSavedAt` turning non-null is that
 *    moment); a fresh compose, which has no row to disagree with, immediately.
 *    The decision itself is pure and clock-free — see `~/utils/postboxDraftMirror`.
 *  - KEY MIGRATION. A fresh compose mirrors under a provisional key because it
 *    has no draft id yet. The instant `ensureDraft` mints one the mirror MOVES
 *    onto it, or the next open — which only knows the draft id — finds nothing.
 *  - CLEAR ON CONFIRMED SAVE. Once the server acknowledges (`lastSavedAt`
 *    advances) it holds the text and the mirror is redundant.
 *  - NEVER RESURRECT A DISCARD. Discarding, or sending — online or into the
 *    offline outbox — tombstones the key in the store, so a write that was
 *    already debounced when the user acted lands as a no-op rather than a
 *    resurrection: the same claim-before-act ordering the offline outbox uses
 *    to keep undo from racing the drain. The tombstone is one-shot (the next
 *    open of that key consumes it), because `new` and `new-reply:<id>` are
 *    shared by every later composition of their kind. Dismissing an offer only
 *    drops the superseded entry — the composer it was offered in is still open,
 *    and what gets typed next deserves the same protection.
 *
 * Fail-soft throughout: the store swallows its own write failures, so a device
 * with no usable IndexedDB degrades to exactly today's server-only autosave.
 */

import { reactive, ref, watch, onScopeDispose, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import type { EditorBlock } from '@owlat/email-builder';
import {
	isBlankDraftFields,
	reconcileDraftMirror,
	type DraftMirrorEntry,
	type DraftMirrorFields,
} from '~/utils/postboxDraftMirror';
import { getPostboxDraftMirrorStore } from '~/utils/postboxDraftMirrorStore';
import type { ComposerMode } from './usePostboxCompose';

/**
 * How long after the last keystroke the mirror is written. Well under the 1.5s
 * server autosave — the whole point is holding what autosave has not sent yet —
 * while still coalescing a burst of typing into one store write.
 */
export const DRAFT_MIRROR_DEBOUNCE_MS = 400;

export interface ComposeMirrorSources {
	mailboxId: Id<'mailboxes'>;
	/** Present when this composer reopened an existing row. */
	seedDraftId?: Id<'mailDrafts'>;
	/** Distinguishes concurrent fresh composes before any of them has a row. */
	inReplyToMessageId?: Id<'mailMessages'>;
	draftId: Ref<Id<'mailDrafts'> | null>;
	/** Server clock: when the row was last saved. Drives the reconcile. */
	lastSavedAt: Ref<number | null>;
	/** Mirroring pauses while the row is read-only (scheduled / pending send). */
	draftState: Ref<'draft' | 'pending_send' | 'scheduled'>;
	toAddresses: Ref<string[]>;
	ccAddresses: Ref<string[]>;
	bccAddresses: Ref<string[]>;
	subject: Ref<string>;
	bodyHtml: Ref<string>;
	bodyBlocks: Ref<EditorBlock[]>;
	composerMode: Ref<ComposerMode>;
}

export function usePostboxComposeMirror(sources: ComposeMirrorSources) {
	const store = getPostboxDraftMirrorStore();
	const namespace = String(sources.mailboxId);
	// One provisional key per composition. A reply keys off the message it
	// answers so reopening the same reply finds its own keystrokes; a blank
	// compose shares one key, which is the honest limit of a scheme that has no
	// server id to key on yet (the first autosave, ~1.5s in, gives it one).
	const provisionalKey = sources.inReplyToMessageId
		? `new-reply:${sources.inReplyToMessageId}`
		: 'new';

	/** The offer, or null. Set at most once, by the reconcile. */
	const restorable: Ref<DraftMirrorEntry | null> = ref(null);

	let activeKey = sources.seedDraftId ? String(sources.seedDraftId) : provisionalKey;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let reconciled = false;

	function snapshot(): DraftMirrorFields {
		return {
			toAddresses: [...sources.toAddresses.value],
			ccAddresses: [...sources.ccAddresses.value],
			bccAddresses: [...sources.bccAddresses.value],
			subject: sources.subject.value,
			bodyHtml: sources.bodyHtml.value,
			// Only in 'full' mode, matching what autosave persists — otherwise a
			// simple-mode mirror would carry blocks the server row never has and
			// read as different from it forever.
			bodyBlocks:
				sources.composerMode.value === 'full'
					? JSON.stringify(sources.bodyBlocks.value)
					: undefined,
			composerMode: sources.composerMode.value,
		};
	}

	function cancelPending() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	async function writeMirror() {
		if (sources.draftState.value !== 'draft') return;
		const fields = snapshot();
		// A blank composer is not work; mirroring it would only leave an entry the
		// next open has to reconcile away for nothing.
		if (isBlankDraftFields(fields)) return;
		await store.save(namespace, activeKey, {
			fields,
			savedAt: Date.now(),
			serverEditedAt: sources.lastSavedAt.value ?? 0,
		});
	}

	/** Read the mirror back and decide whether to offer it. Runs once. */
	async function reconcile() {
		if (reconciled) return;
		reconciled = true;
		// Captured BEFORE the await: for a reopened draft these are the values
		// hydration just wrote, i.e. the server's own copy.
		const serverFields = sources.seedDraftId ? snapshot() : null;
		const key = activeKey;
		const mirror = await store.load(namespace, key);
		const verdict = reconcileDraftMirror({
			mirror,
			serverEditedAt: sources.lastSavedAt.value,
			serverFields,
		});
		if (verdict === 'restore') restorable.value = mirror;
		// A mirror the server has already caught up with is dead weight; drop it
		// rather than re-reading it on every future open of this draft.
		else if (mirror) await store.clear(namespace, key);
	}

	/**
	 * Accept the offer: the mirrored fields go back into the composer, and the
	 * normal autosave path carries them to the server from there.
	 */
	function restore() {
		const entry = restorable.value;
		restorable.value = null;
		if (!entry) return;
		const f = entry.fields;
		sources.toAddresses.value = [...f.toAddresses];
		sources.ccAddresses.value = [...f.ccAddresses];
		sources.bccAddresses.value = [...f.bccAddresses];
		sources.subject.value = f.subject;
		sources.bodyHtml.value = f.bodyHtml;
		sources.composerMode.value = f.composerMode;
		if (f.bodyBlocks) {
			try {
				sources.bodyBlocks.value = JSON.parse(f.bodyBlocks) as EditorBlock[];
			} catch {
				// Malformed blocks: keep whatever the row hydrated with rather than
				// blanking a designed body over a parse failure.
			}
		}
		void store.clear(namespace, activeKey);
	}

	/**
	 * Refuse the offer — a deliberate "keep the saved version". The superseded
	 * entry is dropped, so it is never offered again, but the key stays live:
	 * this composer is still open and everything typed from here on is unsaved
	 * work again. Tombstoning instead would answer one refused offer by turning
	 * crash recovery off for the rest of this draft's life.
	 */
	function dismiss() {
		restorable.value = null;
		void store.clear(namespace, activeKey);
	}

	/** The composition is gone for good (discarded, or sent). */
	function retire() {
		cancelPending();
		restorable.value = null;
		void store.discard(namespace, activeKey);
	}

	watch(
		[
			sources.toAddresses,
			sources.ccAddresses,
			sources.bccAddresses,
			sources.subject,
			sources.bodyHtml,
			sources.bodyBlocks,
			sources.composerMode,
		],
		() => {
			if (sources.draftState.value !== 'draft') return;
			cancelPending();
			timer = setTimeout(() => {
				timer = null;
				void writeMirror();
			}, DRAFT_MIRROR_DEBOUNCE_MS);
		},
		{ deep: true }
	);

	// A confirmed save is both the reconcile trigger for a reopened draft (the
	// row has landed) and the signal that the mirror is redundant (the server
	// now holds this text).
	watch(
		() => sources.lastSavedAt.value,
		(savedAt) => {
			if (savedAt === null) return;
			if (!reconciled) void reconcile();
			else {
				cancelPending();
				void store.clear(namespace, activeKey);
			}
		},
		{ immediate: true }
	);

	// Provisional key → draft id: carry the mirror across so the next open, which
	// only knows the draft id, still finds the keystrokes.
	watch(
		() => sources.draftId.value,
		async (id) => {
			if (!id || String(id) === activeKey) return;
			const from = activeKey;
			activeKey = String(id);
			const carried = await store.load(namespace, from);
			if (carried) {
				await store.save(namespace, activeKey, carried);
				await store.clear(namespace, from);
			}
		}
	);

	// A fresh compose has no row to wait for, so it reconciles right away.
	if (!sources.seedDraftId) void reconcile();

	onScopeDispose(() => cancelPending());

	// `reactive` (not a bag of refs) so the composer template can read
	// `draftMirror.restorable` directly — the same facade shape
	// `usePostboxComposerGuards` returns.
	return reactive({ restorable, restore, dismiss, retire });
}

export type PostboxComposeMirror = ReturnType<typeof usePostboxComposeMirror>;
