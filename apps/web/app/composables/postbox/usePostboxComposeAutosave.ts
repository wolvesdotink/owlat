/**
 * The composer's draft ROW: create it on demand, then keep it in step with the
 * editor through a debounced autosave.
 *
 * Split out of `usePostboxCompose` for the ~500 LOC file-size ratchet, and the
 * seam is the one the rest of the composer already leans on: everything else
 * (attachments, the on-device mirror, the offline outbox, send) reaches the
 * server row through `ensureDraft` and `draftId`, never through the timer.
 *
 * THE TIMER IS NOT EXPORTED. Three callers need to interfere with a pending
 * write and each wants something different, so each gets a verb instead of the
 * handle:
 *
 *  - `flush()`        — write now, then tell me the id (promoting an inline
 *                       reply to a popup: the popup must reopen the SAME row).
 *  - `settlePendingSave()` — send: a debounced write must land BEFORE the send
 *                       mutation reads the row, or the message goes out a
 *                       keystroke stale.
 *  - `cancelAutosave()` — discard and the offline hand-off: the row is about to
 *                       be thrown away or superseded, so a late write is at
 *                       best wasted and at worst resurrects discarded text.
 */

import type { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { EditorBlock } from '@owlat/email-builder';
import type { Ref } from 'vue';
import type { BackendOperation } from '~/composables/useBackendOperation';
import type { ComposerMode } from './usePostboxCompose';

const AUTOSAVE_DEBOUNCE_MS = 1500;

interface AutosaveOptions {
	mailboxId: Id<'mailboxes'>;
	inReplyToMessageId?: Id<'mailMessages'>;
	draftId: Ref<Id<'mailDrafts'> | null>;
	draftState: Ref<'draft' | 'pending_send' | 'scheduled'>;
	ensuring: Ref<boolean>;
	isSaving: Ref<boolean>;
	lastSavedAt: Ref<number | null>;
	toAddresses: Ref<string[]>;
	ccAddresses: Ref<string[]>;
	bccAddresses: Ref<string[]>;
	subject: Ref<string>;
	bodyHtml: Ref<string>;
	bodyBlocks: Ref<EditorBlock[]>;
	composerMode: Ref<ComposerMode>;
	followUpRemindAt: Ref<number | null>;
	createDraft: BackendOperation<typeof api.mail.drafts.create>;
	updateDraft: BackendOperation<typeof api.mail.drafts.update>;
}

export function usePostboxComposeAutosave(opts: AutosaveOptions) {
	const {
		draftId,
		draftState,
		ensuring,
		isSaving,
		lastSavedAt,
		toAddresses,
		ccAddresses,
		bccAddresses,
		subject,
		bodyHtml,
		bodyBlocks,
		composerMode,
		followUpRemindAt,
		createDraft,
		updateDraft,
	} = opts;

	async function ensureDraft(): Promise<Id<'mailDrafts'> | null> {
		if (draftId.value) return draftId.value;
		if (ensuring.value) return null;
		ensuring.value = true;
		try {
			const result = await createDraft.run({
				mailboxId: opts.mailboxId,
				inReplyToMessageId: opts.inReplyToMessageId,
			});
			if (!result.ok) return null;
			draftId.value = result.result.draftId as Id<'mailDrafts'>;
			if (result.result.inReplySubject && !subject.value) {
				subject.value = result.result.inReplySubject.match(/^re\s*:\s*/i)
					? result.result.inReplySubject
					: `Re: ${result.result.inReplySubject}`;
			}
			if (result.result.inReplyFrom && toAddresses.value.length === 0) {
				toAddresses.value = [result.result.inReplyFrom];
			}
			return draftId.value;
		} finally {
			ensuring.value = false;
		}
	}

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingSave: Promise<void> | null = null;

	function schedulePersist() {
		// A scheduled (or pending_send) row is read-only until unscheduled —
		// drafts.update rejects it. Skip autosave so touching a field while
		// reviewing a scheduled draft doesn't spam 'Save draft' error toasts.
		if (draftState.value !== 'draft') return;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			pendingSave = persist();
		}, AUTOSAVE_DEBOUNCE_MS);
	}

	async function persist(): Promise<void> {
		const id = await ensureDraft();
		if (!id) return;
		isSaving.value = true;
		try {
			const result = await updateDraft.run({
				draftId: id,
				toAddresses: toAddresses.value,
				ccAddresses: ccAddresses.value,
				bccAddresses: bccAddresses.value,
				subject: subject.value,
				bodyHtml: bodyHtml.value,
				// Only persist blocks when in 'full' mode — keeps simple-mode
				// drafts small and unambiguous on the wire.
				bodyBlocks: composerMode.value === 'full' ? JSON.stringify(bodyBlocks.value) : undefined,
				composerMode: composerMode.value,
				// Always sent: a timestamp arms, explicit null clears server-side.
				followUpRemindAt: followUpRemindAt.value,
			});
			if (!result.ok) return;
			lastSavedAt.value = (result.result.savedAt as number) ?? Date.now();
		} finally {
			isSaving.value = false;
		}
	}

	/**
	 * Flush any pending autosave immediately and return the draft id (creating
	 * the row if it doesn't exist yet). Used when promoting an inline reply to
	 * a popup so the popup reopens the SAME draft with nothing lost.
	 */
	async function flush(): Promise<Id<'mailDrafts'> | null> {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		// Scheduled/pending rows are read-only (drafts.update rejects them) —
		// just report the id without persisting.
		if (draftState.value === 'draft') {
			pendingSave = persist();
			await pendingSave;
		}
		return draftId.value;
	}

	// Watch for any field change
	watch(
		[
			toAddresses,
			ccAddresses,
			bccAddresses,
			subject,
			bodyHtml,
			bodyBlocks,
			composerMode,
			followUpRemindAt,
		],
		() => {
			schedulePersist();
		},
		{ deep: true }
	);

	/** Drop a debounced write on the floor — the row is going away or is stale. */
	function cancelAutosave(): void {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
	}

	/**
	 * Make sure whatever the editor holds has reached the server, then resolve.
	 * Send calls this before the send mutation reads the row.
	 */
	async function settlePendingSave(): Promise<void> {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
			pendingSave = persist();
		}
		if (pendingSave) await pendingSave;
	}

	return { ensureDraft, flush, cancelAutosave, settlePendingSave };
}
