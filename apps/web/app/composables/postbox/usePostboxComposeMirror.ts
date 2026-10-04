/**
 * The composer's local draft mirror (plan idea 7): keep and ask.
 *
 * Writes what is on screen to the device (the session's own `live` copy), and
 * on open offers back copies other sessions left behind (a crash, a closed tab,
 * a failed save, the compose page left before its text reached the server).
 * The policy and its guarantees are in `~/utils/postboxDraftMirror`; the
 * storage contract in `~/utils/postboxDraftMirrorStore`. In short:
 *
 *   - G1 no silent loss: a copy goes only when it equals the latest observed
 *     row, when a person resolves it, or when retention expires it;
 *   - G2 no silent overwrite: Restore asks when the row is not provably the one
 *     the copy was taken against, re-checks right before applying, and writes
 *     through autosave's ordered queue;
 *   - G3 no placeholders: nothing is written before the row has loaded;
 *   - G4 leaving never drops the only copy (the compose page's side is
 *     `pages/dashboard/compose.vue`; here: a final write on dispose, and
 *     migration to the draft once its row exists, even after dispose).
 *
 * WRITING. Every field change bumps `revision` and arms a 400 ms debounce.
 * A write captures `{revision, fields}`; only a COMMITTED write advances
 * `writtenRevision` and `lastWritten`, so a failed write leaves the edit dirty
 * and the next change or eligibility change retries it. All of this session's
 * storage operations run on one promise chain that survives a rejected
 * operation; operations queued before dispose still run after it.
 */

import { computed, reactive, ref, shallowRef, watch, onScopeDispose, type Ref } from 'vue';
import {
	applyMirrorFields,
	isBlankMirrorFields,
	plainMirrorFields,
	mirrorFieldsEqual,
	mirrorFieldsOf,
	pickNewest,
	restoreNeedsConfirmation,
	type MirrorCopy,
	type MirrorFields,
} from '~/utils/postboxDraftMirror';
import {
	getPostboxDraftMirrorStore,
	mirrorCopyKey,
	provisionalDraftKey,
} from '~/utils/postboxDraftMirrorStore';
import { holdMirrorSessionLock, liveMirrorSessions } from '~/utils/postboxDraftMirrorLocks';
import { scanMirrorOffers } from '~/utils/postboxDraftMirrorScan';
import type {
	ComposeMirrorSources,
	MirrorOffer,
	RestoredWrite,
	RestoreOutcome,
} from './usePostboxComposeMirrorTypes';

export type { ComposeMirrorSources, MirrorOffer, RestoreOutcome };

/**
 * How long after the last keystroke the mirror is written. Well under the 1.5s
 * server autosave — the whole point is holding what autosave has not sent yet —
 * while still coalescing a burst of typing into one store write.
 */
export const DRAFT_MIRROR_DEBOUNCE_MS = 400;

/** How long Restore waits for a row it just created to be observed. */
const ROW_OBSERVE_TIMEOUT_MS = 10_000;

function randomId(): string {
	return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

export function usePostboxComposeMirror(sources: ComposeMirrorSources) {
	const store = getPostboxDraftMirrorStore();
	const ns = String(sources.mailboxId);
	const sessionId = randomId();
	const inReplyTo = sources.inReplyToMessageId ? String(sources.inReplyToMessageId) : null;

	let revision = 0;
	let writtenRevision = 0;
	let lastWritten: MirrorFields | null = null;
	let retired = false;
	let disposed = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let chain: Promise<unknown> = Promise.resolve();
	let scanToken = 0;

	const offer: Ref<MirrorOffer | null> = shallowRef(null);
	/** Restore / Keep in progress: the composer locks its fields meanwhile. */
	const busy = ref(false);

	function enqueue<T>(op: () => Promise<T>): Promise<T> {
		const next = chain.then(op, op);
		chain = next.catch(() => undefined);
		return next;
	}

	function draftKey(): string {
		return sources.draftId.value ? String(sources.draftId.value) : provisionalDraftKey(sessionId);
	}

	function capture(): { revision: number; fields: MirrorFields } {
		return { revision, fields: mirrorFieldsOf(sources) };
	}

	function loadedRow(): MirrorFields | null {
		const row = sources.latestRow.value;
		return row.status === 'loaded' ? row.fields : null;
	}

	const eligible = computed(
		() => sources.ready.value && sources.draftState.value === 'draft' && !retired
	);

	// Other tabs do not offer this session's copies while it lives.
	const releaseLock = holdMirrorSessionLock(sessionId);

	// ── Writing ────────────────────────────────────────────────────────────────

	function writeLive(captured: { revision: number; fields: MirrorFields }): Promise<boolean> {
		return enqueue(async () => {
			if (retired) return false;
			// The key is fixed now: the row may be created while this write is out.
			const writingUnder = draftKey();
			const key = mirrorCopyKey(ns, writingUnder, sessionId, 'live');
			const row = loadedRow();
			const fields = captured.fields;
			// Nothing worth keeping: an untouched empty composer, or text equal to
			// the row (already saved). Drop this session's own copy instead.
			const equalsRow = row !== null && mirrorFieldsEqual(fields, row);
			const neverWritten = lastWritten === null;
			if (equalsRow || (isBlankMirrorFields(fields) && neverWritten && row === null)) {
				const removed = await store.remove(key);
				if (removed) {
					lastWritten = null;
					writtenRevision = Math.max(writtenRevision, captured.revision);
				}
				return removed;
			}
			if (lastWritten && mirrorFieldsEqual(lastWritten, fields)) {
				writtenRevision = Math.max(writtenRevision, captured.revision);
				return true;
			}
			const copy: MirrorCopy = {
				v: 2,
				fields,
				base: plainMirrorFields(row),
				savedAt: Date.now(),
				draftId: sources.draftId.value ? String(sources.draftId.value) : null,
				inReplyTo,
			};
			const ok = await store.write(key, copy);
			if (ok) {
				lastWritten = fields;
				writtenRevision = Math.max(writtenRevision, captured.revision);
				void sweepAfterWrite();
			}
			return ok;
		});
	}

	/** Retention and the per-mailbox cap, never touching live sessions' copies. */
	async function sweepAfterWrite(): Promise<void> {
		const live = await liveMirrorSessions();
		await store.sweep(
			ns,
			Date.now(),
			(record) =>
				record.sessionId === sessionId || live.has(record.sessionId) || isOffered(record.key)
		);
	}

	function isOffered(key: string): boolean {
		const current = offer.value;
		return current?.source.kind === 'v2' && current.source.record.key === key;
	}

	function dirty(): boolean {
		return revision > writtenRevision;
	}

	function flushIfEligible(): Promise<boolean> {
		if (!eligible.value || !dirty()) return Promise.resolve(!dirty());
		return writeLive(capture());
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
			sources.followUpRemindAt,
		],
		() => {
			revision += 1;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				void flushIfEligible();
			}, DRAFT_MIRROR_DEBOUNCE_MS);
		},
		{ deep: true, flush: 'sync' }
	);

	// A write blocked while loading, scheduled or unready lands the moment it
	// may; and an offer the composer could not show yet is looked for again.
	watch(eligible, (now) => {
		if (!now) return;
		void flushIfEligible();
		if (!offer.value) void reconcile();
	});

	/**
	 * Write now (the compose page, leaving). Resolves true only when what is on
	 * screen is held durably: written, or equal to what was already written.
	 */
	function writeNow(): Promise<boolean> {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (!eligible.value) return Promise.resolve(false);
		return writeLive(capture());
	}

	// ── Offering ───────────────────────────────────────────────────────────────

	/** Look for a copy to offer. Publishes only if nothing moved meanwhile. */
	function reconcile(): Promise<void> {
		const token = ++scanToken;
		const draftAtStart = sources.draftId.value;
		return enqueue(async () => {
			if (disposed || retired || offer.value) return;
			const row = sources.latestRow.value;
			const rowless = draftAtStart === null;
			if (!rowless && row.status !== 'loaded') return;
			if (row.status === 'loaded' && row.state !== 'draft') return;
			const rowFields = row.status === 'loaded' ? row.fields : null;
			const candidates = await scanMirrorOffers(store, {
				ns,
				sessionId,
				draftId: rowless ? null : String(draftAtStart),
				inReplyTo,
				row: rowFields,
				live: await liveMirrorSessions(),
				now: Date.now(),
				onScreen: () => mirrorFieldsOf(sources),
				latestRow: loadedRow,
				stillCurrent: () =>
					token === scanToken && !disposed && !retired && sources.draftId.value === draftAtStart,
			});
			const chosen = pickNewest(candidates);
			// Publish guard: identity, row, lifecycle and offer state unchanged.
			const latest = sources.latestRow.value;
			if (
				!chosen ||
				token !== scanToken ||
				disposed ||
				retired ||
				offer.value ||
				sources.draftId.value !== draftAtStart ||
				(!rowless && (latest.status !== 'loaded' || latest.state !== 'draft'))
			) {
				return;
			}
			offer.value = chosen;
		});
	}

	// A row confirmed gone closes the offer; a newly known row looks for one.
	watch(
		() => sources.latestRow.value.status,
		(status) => {
			if (status === 'missing') offer.value = null;
			if (status === 'loaded' && !offer.value && eligible.value) void reconcile();
		}
	);
	// Opening (a fresh composition has no row to wait for).
	if (sources.ready.value) void reconcile();

	// ── Resolving ──────────────────────────────────────────────────────────────

	async function removeSource(current: MirrorOffer): Promise<boolean> {
		if (current.source.kind === 'legacy') return store.removeLegacy(current.source.record);
		for (const twin of current.twins ?? []) await store.removeIfUnchanged(twin.key, twin.copy);
		return store.removeIfUnchanged(current.source.record.key, current.source.record.copy);
	}

	function waitForLoadedRow(): Promise<MirrorFields | null> {
		const existing = loadedRow();
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve) => {
			const stop = watch(
				() => sources.latestRow.value,
				(row) => {
					if (row.status === 'loaded') {
						stop();
						clearTimeout(timeout);
						resolve(row.fields);
					} else if (row.status === 'missing') {
						stop();
						clearTimeout(timeout);
						resolve(null);
					}
				}
			);
			const timeout = setTimeout(() => {
				stop();
				resolve(null);
			}, ROW_OBSERVE_TIMEOUT_MS);
		});
	}

	/**
	 * Restore the offered copy. Without `confirmed`, a copy whose row may have
	 * moved on reports `needs-confirmation` and changes nothing. With it, the
	 * restore proceeds only if the row still equals the one the person
	 * confirmed against.
	 */
	async function restore(confirmed?: { row: MirrorFields | null }): Promise<RestoreOutcome> {
		const current = offer.value;
		if (!current || busy.value) return { status: 'aborted', reason: 'busy' };
		busy.value = true;
		sources.autosave.pause();
		try {
			// A fresh composition gets its row first, then is checked like any other.
			if (!sources.draftId.value) {
				const id = await sources.autosave.ensureDraft();
				if (!id) return { status: 'aborted', reason: 'unavailable' };
			}
			const checkedRow = await waitForLoadedRow();
			const latest = sources.latestRow.value;
			if (
				!checkedRow ||
				latest.status !== 'loaded' ||
				latest.state !== 'draft' ||
				disposed ||
				retired
			) {
				return { status: 'aborted', reason: 'unavailable' };
			}
			if (confirmed) {
				if (!confirmed.row || !mirrorFieldsEqual(confirmed.row, checkedRow)) {
					return { status: 'needs-confirmation' };
				}
			} else if (restoreNeedsConfirmation(current, checkedRow)) {
				return { status: 'needs-confirmation' };
			}

			// Earlier writes land first; then nothing writes until R is queued.
			await sources.autosave.drain();

			// Set aside what the editor holds, if it is not already on the server.
			let backupAt = revision;
			const onScreen = capture();
			// Blank included: a deliberate clear is text too.
			if (!mirrorFieldsEqual(onScreen.fields, checkedRow)) {
				const backup: MirrorCopy = {
					v: 2,
					fields: onScreen.fields,
					base: plainMirrorFields(checkedRow),
					savedAt: Date.now(),
					draftId: sources.draftId.value ? String(sources.draftId.value) : null,
					inReplyTo,
				};
				const key = mirrorCopyKey(ns, draftKey(), sessionId, `pre-restore.${randomId()}`);
				const stored = await enqueue(() => store.write(key, backup));
				if (!stored) return { status: 'aborted', reason: 'backup-failed' };
				backupAt = onScreen.revision;
			}

			// Re-check right before applying (G2): the row, the lifecycle, and that
			// nothing changed the editor since the backup was taken.
			const now = sources.latestRow.value;
			if (
				disposed ||
				retired ||
				now.status !== 'loaded' ||
				now.state !== 'draft' ||
				!mirrorFieldsEqual(now.fields, checkedRow) ||
				revision !== backupAt
			) {
				return now.status === 'loaded' && now.state === 'draft'
					? { status: 'needs-confirmation' }
					: { status: 'aborted', reason: 'unavailable' };
			}

			sources.touched.applying(() => applyMirrorFields(sources, current.fields, current.present));
			const restored = capture();
			const write: RestoredWrite = {
				toAddresses: restored.fields.toAddresses,
				ccAddresses: restored.fields.ccAddresses,
				bccAddresses: restored.fields.bccAddresses,
				subject: restored.fields.subject,
				bodyHtml: restored.fields.bodyHtml,
				bodyBlocks: restored.fields.bodyBlocks ?? '[]',
				composerMode: restored.fields.composerMode,
				followUpRemindAt: restored.fields.followUpRemindAt,
			};
			// Reserve R in autosave's queue before the editor unlocks.
			const persisted = sources.autosave.persistRestored(write);
			offer.value = null;
			sources.autosave.resume();
			busy.value = false;

			await writeLive(restored);
			const saved = await persisted;
			if (saved.ok) await removeSource(current);
			void reconcile();
			return { status: 'restored' };
		} finally {
			if (busy.value) {
				busy.value = false;
				sources.autosave.resume();
			}
		}
	}

	/** Keep saved version: resolve the offered copy (an explicit decision, G1b). */
	async function keep(): Promise<void> {
		const current = offer.value;
		if (!current || busy.value) return;
		busy.value = true;
		try {
			offer.value = null;
			await removeSource(current);
		} finally {
			busy.value = false;
		}
		void reconcile();
	}

	/** The composition is over (Discard, Send): this session's live copy goes. */
	function retire() {
		retired = true;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		offer.value = null;
		// Behind any write already queued, and run despite `retired`: every live
		// key the session may own (a failed migration leaves the provisional one).
		// Keys fixed now: Discard clears the draft id while this waits.
		const keys = [provisionalDraftKey(sessionId)];
		if (sources.draftId.value) keys.push(String(sources.draftId.value));
		void enqueue(async () => {
			for (const key of keys) await store.remove(mirrorCopyKey(ns, key, sessionId, 'live'));
		});
	}

	// ── The row arrives (even after dispose): move provisional copies onto it.
	const stopCreated = sources.autosave.onCreated((id) => {
		void enqueue(async () => {
			if (retired) return;
			const from = provisionalDraftKey(sessionId);
			await store.migrateSession(ns, sessionId, from, String(id));
		});
		if (disposed) stopCreated();
	});

	onScopeDispose(() => {
		disposed = true;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		// The final snapshot is taken now, synchronously; its write runs later.
		if (eligible.value && dirty()) void writeLive(capture());
		void enqueue(async () => {
			releaseLock();
		});
		if (sources.draftId.value) stopCreated();
	});

	// `reactive` (not a bag of refs) so the composer template can read
	// `draftMirror.offer` directly.
	return reactive({
		offer,
		busy,
		restore,
		keep,
		retire,
		writeNow,
		/** Look for copies again (the compose page stored one for this draft). */
		rescan: () => reconcile(),
		/** The latest observed row, for the confirmation dialog to remember. */
		confirmationRow: computed(() => loadedRow()),
	});
}

export type ComposeMirror = ReturnType<typeof usePostboxComposeMirror>;
