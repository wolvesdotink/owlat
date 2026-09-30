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
 *
 * `flush()` and `settlePendingSave()` resolve to the Operation envelope, and
 * `ok: true` means one thing only: the server acknowledged the snapshot the
 * editor holds NOW (#895). A failed write, a write of an older snapshot, or a
 * draft row that could not be created is `ok: false`, and the failure has
 * already been surfaced by the operation that failed.
 *
 * Nothing is written while a reopened draft is still loading (#896): every
 * write is a complete snapshot, and before the row arrives that snapshot holds
 * empty recipients and an empty body, which `drafts.update` would store over
 * the saved ones.
 */

import type { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { EditorBlock } from '@owlat/email-builder';
import type { Ref } from 'vue';
import type { BackendOperation, BackendOperationResult } from '~/composables/useBackendOperation';
import { composeDraftFields } from '~/utils/postboxDraftFields';
import type { ComposerMode } from './usePostboxCompose';
import type { InitialHydrationState } from './usePostboxComposeHydration';

const AUTOSAVE_DEBOUNCE_MS = 1500;

interface AutosaveOptions {
	mailboxId: Id<'mailboxes'>;
	inReplyToMessageId?: Id<'mailMessages'>;
	draftId: Ref<Id<'mailDrafts'> | null>;
	draftState: Ref<'draft' | 'pending_send' | 'scheduled'>;
	/** Whether a reopened draft's row has loaded; always 'ready' for a new one. */
	initialHydration: Ref<InitialHydrationState>;
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
		initialHydration,
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

	// A second caller while the row is being created (an attachment upload and
	// a save, say) waits for the same row rather than being told there is none.
	let creating: Promise<Id<'mailDrafts'> | null> | null = null;

	function ensureDraft(): Promise<Id<'mailDrafts'> | null> {
		if (draftId.value) return Promise.resolve(draftId.value);
		creating ??= createRow().finally(() => {
			creating = null;
		});
		return creating;
	}

	async function createRow(): Promise<Id<'mailDrafts'> | null> {
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
	let pendingSave: Promise<BackendOperationResult<Id<'mailDrafts'>>> | null = null;
	// The snapshot the server last acknowledged, and for which row.
	let acknowledged: { id: Id<'mailDrafts'>; key: string } | null = null;

	/** Everything `drafts.update` receives besides the id: the canonical snapshot. */
	function snapshot() {
		return {
			// The same one the on-device mirror stores (so its restore offer
			// compares like with like).
			...composeDraftFields(opts),
			// Always sent: a timestamp arms, explicit null clears server-side.
			followUpRemindAt: followUpRemindAt.value,
		};
	}

	function isAcknowledged(id: Id<'mailDrafts'> | null): id is Id<'mailDrafts'> {
		return (
			id !== null && acknowledged?.id === id && acknowledged.key === JSON.stringify(snapshot())
		);
	}

	function clearTimer() {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
	}

	function schedulePersist() {
		// A scheduled (or pending_send) row is read-only until unscheduled —
		// drafts.update rejects it. Skip autosave so touching a field while
		// reviewing a scheduled draft doesn't spam 'Save draft' error toasts.
		if (draftState.value !== 'draft') return;
		// Early edits wait for the row; hydration merges them and wakes us.
		if (initialHydration.value !== 'ready') return;
		clearTimer();
		saveTimer = setTimeout(() => {
			saveTimer = null;
			pendingSave = persist();
		}, AUTOSAVE_DEBOUNCE_MS);
	}

	async function persist(): Promise<BackendOperationResult<Id<'mailDrafts'>>> {
		// Unreachable from the composer, which checks readiness first and tells
		// the user why; kept so no path can ever write unloaded defaults.
		if (initialHydration.value !== 'ready') return { ok: false };
		const id = await ensureDraft();
		if (!id) return { ok: false };
		const fields = snapshot();
		isSaving.value = true;
		try {
			const result = await updateDraft.run({ draftId: id, ...fields });
			if (!result.ok) return { ok: false };
			acknowledged = { id, key: JSON.stringify(fields) };
			lastSavedAt.value = (result.result.savedAt as number) ?? Date.now();
			return { ok: true, result: id };
		} finally {
			isSaving.value = false;
		}
	}

	/**
	 * Make sure the snapshot the editor holds NOW has reached the server, and
	 * resolve to the row it lives on. Send calls this before the send mutation
	 * reads the row.
	 *
	 * An in-flight write is awaited first, but its success is not taken on
	 * trust: it may have carried an older snapshot, and it may have failed. Only
	 * an acknowledgement of the current fields skips the write; anything else
	 * writes again, so a debounced save that failed earlier is retried here
	 * rather than leaving the row a step behind the editor.
	 *
	 * `beforeWrite` runs between the two, so a caller can judge the write it
	 * asked for apart from the earlier one it only waited on.
	 */
	async function settlePendingSave(
		beforeWrite?: () => void
	): Promise<BackendOperationResult<Id<'mailDrafts'>>> {
		clearTimer();
		if (pendingSave) await pendingSave;
		const id = draftId.value;
		// Read-only rows (scheduled / pending send) cannot be written; there is
		// nothing of the editor's they could be missing.
		if (id && draftState.value !== 'draft') return { ok: true, result: id };
		if (isAcknowledged(id)) return { ok: true, result: id };
		beforeWrite?.();
		pendingSave = persist();
		return pendingSave;
	}

	/**
	 * Save now and return the draft id (creating the row if it doesn't exist
	 * yet). Used when promoting an inline reply to a popup so the popup reopens
	 * the SAME draft with nothing lost — which is only true when the save landed,
	 * so a failure is `ok: false` and the caller stays put.
	 */
	async function flush(): Promise<BackendOperationResult<Id<'mailDrafts'> | null>> {
		// Scheduled/pending rows are read-only (drafts.update rejects them) —
		// just report the id without persisting.
		if (draftState.value !== 'draft') {
			clearTimer();
			return { ok: true, result: draftId.value };
		}
		return settlePendingSave();
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

	// The row has loaded and any early edits are merged over it: save them.
	watch(initialHydration, (state) => {
		if (state === 'ready') schedulePersist();
	});

	/** Drop a debounced write on the floor — the row is going away or is stale. */
	function cancelAutosave(): void {
		clearTimer();
	}

	return { ensureDraft, flush, cancelAutosave, settlePendingSave };
}
