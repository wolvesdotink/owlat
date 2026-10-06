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
 *  - `flush()`        — write now, then tell me the id (Answer mode left with
 *                       something typed, an ask session that needs the row).
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
 *
 * ONE ORDERED QUEUE. Every write (the debounced save, flush, send settlement,
 * and the device mirror's Restore) runs through one queue, so a later write can
 * never land before an earlier one and replace newer text with older. Restore
 * pauses scheduling, drains the queue, and reserves its own write before the
 * editor unlocks (`pause` / `drain` / `persistRestored` / `resume`).
 *
 * Creating the row passes the compose request's nonce when there is one, so a
 * remount of the same request gets the same row back (`existing`, reopened
 * like any saved draft) or learns it was sent or discarded (`missing`, nothing
 * is created again). Listeners registered through `onCreated` hear about the
 * row even when it lands after the composer has gone away.
 */

import type { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { EditorBlock } from '@owlat/email-builder';
import type { Ref } from 'vue';
import type { BackendOperation, BackendOperationResult } from '~/composables/useBackendOperation';
import { composeDraftFields } from '~/utils/postboxDraftFields';
import { answerDraftHasContent } from '~/utils/answerMode';
import type { ComposerMode } from './usePostboxCompose';
import type { InitialHydrationState } from './usePostboxComposeHydration';
import type { ComposeTouched } from './usePostboxComposeTouched';
import type { ExpectedAttachmentRequest } from './usePostboxComposeExpected';

const AUTOSAVE_DEBOUNCE_MS = 1500;
/** Writes `settlePendingSave` makes before giving up on fields that keep changing. */
const SETTLE_WRITES = 3;

/**
 * What `settlePendingSave` / `flush` resolve to: the Operation envelope, plus
 * one refusal no operation surfaced — every write landed, but the fields kept
 * changing under them — which the caller has to explain itself.
 */
export type SettleOutcome<T> = BackendOperationResult<T> | { ok: false; stillChanging: true };

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
	/** The shared tracker: the server's To/Subject only fill untouched fields. */
	touched: ComposeTouched;
	/** The compose request's creation nonce, when the host has one. */
	requestNonce?: string;
	/** Files the new row owes until they are attached (usePostboxComposeExpected). */
	expectedAttachments?: ExpectedAttachmentRequest[];
	/**
	 * The nonce named an existing row: reopen it (the composer merges it like
	 * any saved draft) before the id is published, so nothing writes first.
	 */
	onReopenExisting: () => void;
	/** The nonce named a draft that has since been sent or discarded. */
	onGone: () => void;
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
	// The request's draft is gone (sent or discarded): never create another.
	let gone = false;
	const createdListeners = new Set<(id: Id<'mailDrafts'>) => void>();

	/** Hear about the row once it exists, even after this composer is gone. */
	function onCreated(listener: (id: Id<'mailDrafts'>) => void): () => void {
		createdListeners.add(listener);
		return () => createdListeners.delete(listener);
	}

	function ensureDraft(): Promise<Id<'mailDrafts'> | null> {
		if (draftId.value) return Promise.resolve(draftId.value);
		if (gone) return Promise.resolve(null);
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
				...(opts.requestNonce ? { requestNonce: opts.requestNonce } : {}),
				...(opts.expectedAttachments?.length
					? { expectedAttachments: opts.expectedAttachments }
					: {}),
			});
			if (!result.ok) return null;
			const created = result.result;
			if (created.existing && created.missing) {
				gone = true;
				opts.onGone();
				return null;
			}
			if (created.existing) {
				// A remount of the same request: this is a saved draft now.
				opts.onReopenExisting();
			} else {
				// The server's envelope (a reply's Reply-To and `Re:` subject) fills
				// only what the person has not set; a deliberate clear stays clear.
				opts.touched.applying(() => {
					if (!opts.touched.isTouched('toAddresses')) toAddresses.value = [...created.toAddresses];
					if (!opts.touched.isTouched('subject')) subject.value = created.subject;
				});
			}
			const id = created.draftId as Id<'mailDrafts'>;
			draftId.value = id;
			for (const listener of createdListeners) {
				try {
					listener(id);
				} catch {
					// One listener's failure must not keep the row from the rest.
				}
			}
			return id;
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

	// The one ordered queue every write goes through (see the module header).
	let writeQueue: Promise<unknown> = Promise.resolve();
	function enqueue<T>(op: () => Promise<T>): Promise<T> {
		const next = writeQueue.then(op, op);
		writeQueue = next.catch(() => undefined);
		pendingSave = next as Promise<BackendOperationResult<Id<'mailDrafts'>>>;
		return next;
	}
	/** Wait until every write queued so far has settled. */
	async function drain(): Promise<void> {
		await writeQueue;
	}

	// Restore holds new scheduled saves while it backs up and applies.
	let paused = false;
	let scheduledWhilePaused = false;
	function pause() {
		paused = true;
		if (saveTimer) {
			clearTimer();
			scheduledWhilePaused = true;
		}
	}
	function resume() {
		paused = false;
		if (scheduledWhilePaused) {
			scheduledWhilePaused = false;
			schedulePersist();
		}
	}

	function schedulePersist() {
		// A scheduled (or pending_send) row is read-only until unscheduled —
		// drafts.update rejects it. Skip autosave so touching a field while
		// reviewing a scheduled draft doesn't spam 'Save draft' error toasts.
		if (draftState.value !== 'draft') return;
		// Early edits wait for the row; hydration merges them and wakes us.
		if (initialHydration.value !== 'ready') return;
		if (paused) {
			scheduledWhilePaused = true;
			return;
		}
		clearTimer();
		saveTimer = setTimeout(() => {
			saveTimer = null;
			persist();
		}, AUTOSAVE_DEBOUNCE_MS);
	}

	function persist(): Promise<BackendOperationResult<Id<'mailDrafts'>>> {
		return enqueue(() => write(() => snapshot()));
	}

	/**
	 * Write one snapshot: the live fields at the moment the queue reaches it
	 * (ordinary saves), or a fixed snapshot (Restore).
	 */
	async function write(
		take: () => ReturnType<typeof snapshot> & { bodyBlocks?: string },
		acknowledgedAs: () => ReturnType<typeof snapshot> = () => snapshot()
	): Promise<BackendOperationResult<Id<'mailDrafts'>>> {
		// Unreachable from the composer, which checks readiness first and tells
		// the user why; kept so no path can ever write unloaded defaults.
		if (initialHydration.value !== 'ready') return { ok: false };
		const id = await ensureDraft();
		if (!id) return { ok: false };
		// Creating the row may have reopened an existing one: wait for its merge.
		if (initialHydration.value !== 'ready') return { ok: false };
		const fields = take();
		// What this write acknowledges, fixed now: the fields keep changing while
		// it is out, and a later edit must not count as saved by it.
		const key = JSON.stringify(acknowledgedAs());
		isSaving.value = true;
		try {
			const result = await updateDraft.run({ draftId: id, ...fields });
			if (!result.ok) return { ok: false };
			acknowledged = { id, key };
			lastSavedAt.value = (result.result.savedAt as number) ?? Date.now();
			return { ok: true, result: id };
		} finally {
			isSaving.value = false;
		}
	}

	/**
	 * Restore's write: exactly the restored snapshot `restored` (the wire
	 * snapshot plus the restored blocks, sent even in simple mode, once), queued
	 * behind every earlier write. Later edits queue behind it.
	 */
	function persistRestored(
		restored: ReturnType<typeof snapshot> & { bodyBlocks: string }
	): Promise<BackendOperationResult<Id<'mailDrafts'>>> {
		const { bodyBlocks: _blocks, ...wire } = restored;
		const acknowledgedWire = {
			...wire,
			bodyBlocks: restored.composerMode === 'full' ? restored.bodyBlocks : undefined,
		};
		return enqueue(() =>
			write(
				() => restored,
				() => acknowledgedWire
			)
		);
	}

	/**
	 * Make sure the snapshot the editor holds NOW has reached the server, and
	 * resolve to the row it lives on. Send calls this before the send mutation
	 * reads the row.
	 *
	 * No save is taken on trust, its own included: an in-flight write may carry
	 * an older snapshot or fail, and the fields stay editable while a write is
	 * outstanding, so an acknowledgement can be a keystroke stale by the time it
	 * lands. After every awaited write the acknowledged snapshot is compared
	 * with the current fields, and a mismatch writes again. The loop is bounded:
	 * fields that are still changing after `SETTLE_WRITES` writes resolve to
	 * `stillChanging`, which the caller surfaces itself — never to a send of an
	 * older snapshot. The autosave is re-armed first, so the last edit still
	 * reaches the server on the normal debounce.
	 *
	 * `beforeWrite` runs before each write this call makes, so a caller can judge
	 * those writes apart from an earlier one it only waited on.
	 */
	async function settlePendingSave(
		beforeWrite?: () => void
	): Promise<SettleOutcome<Id<'mailDrafts'>>> {
		for (let writes = 0; ; writes += 1) {
			clearTimer();
			await drain();
			const id = draftId.value;
			// Read-only rows (scheduled / pending send) cannot be written; there is
			// nothing of the editor's they could be missing.
			if (id && draftState.value !== 'draft') return { ok: true, result: id };
			if (isAcknowledged(id)) return { ok: true, result: id };
			if (writes === SETTLE_WRITES) {
				// The loop cleared the timer the latest edit armed; put it back.
				schedulePersist();
				return { ok: false, stillChanging: true };
			}
			beforeWrite?.();
			pendingSave = persist();
			const saved = await pendingSave;
			if (!saved.ok) return saved;
		}
	}

	/**
	 * Save now and return the draft id (creating the row if it doesn't exist
	 * yet). Used when Answer mode is left with something typed in the last
	 * debounce window, and when an ask session needs the row. Nothing
	 * is lost only when the save landed, so a failure is `ok: false` and the
	 * caller stays put.
	 */
	async function flush(): Promise<SettleOutcome<Id<'mailDrafts'> | null>> {
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

	// A composer that goes away with a debounced write still armed (the compose
	// page or Answer mode left by the browser's Back within 1.5 s) saves it now:
	// the edit exists nowhere else (the crash mirror is keyed by the row). The
	// one timer that is dropped is a row-less composer's that holds nothing the
	// person wrote (a signature or a hydration re-arm, say): saving it would
	// leave an empty draft nobody asked for. The editor itself emits nothing on
	// a blur without an edit, so an untouched reply never arms the timer.
	const seededEnvelope = envelopeKey();
	function envelopeKey(): string {
		return JSON.stringify([
			toAddresses.value,
			ccAddresses.value,
			bccAddresses.value,
			subject.value,
		]);
	}
	function holdsAnEdit(): boolean {
		return (
			answerDraftHasContent(bodyHtml.value, 0) ||
			bodyBlocks.value.length > 0 ||
			envelopeKey() !== seededEnvelope
		);
	}
	onScopeDispose(() => {
		if (!saveTimer) return;
		clearTimer();
		if (draftId.value || holdsAnEdit()) pendingSave = persist();
	});

	/** Drop a debounced write on the floor — the row is going away or is stale. */
	function cancelAutosave(): void {
		clearTimer();
	}

	return {
		ensureDraft,
		flush,
		cancelAutosave,
		settlePendingSave,
		onCreated,
		pause,
		resume,
		drain,
		persistRestored,
	};
}
