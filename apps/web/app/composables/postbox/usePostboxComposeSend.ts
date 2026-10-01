/**
 * Send (and the flush before Answer mode) for the composer, split out of
 * `usePostboxCompose` for the file-size ratchet. What lives here is the
 * persistence contract those two stand on:
 *
 *  - SEND READS THE ROW, so the row must hold what the editor holds. Send goes
 *    ahead only once the server has acknowledged the CURRENT snapshot. A save
 *    that failed or carried an older snapshot, and an edit made while Send's
 *    own save was out, are written again at the Send boundary (up to three
 *    writes); if a write fails, or the fields are still changing after that,
 *    nothing is sent (#895). The composer stays open with the text and its
 *    recovery mirror, no undo window is armed, and `draftNotice` says why.
 *  - A TRANSPORT failure (a save or send the connection dropped) is claimed
 *    rather than toasted and hands the composition to the offline outbox, whose
 *    payload is the complete, current snapshot — never an online send of a
 *    stale row.
 *  - A reopened draft sends nothing, online or queued, before its row has
 *    loaded (#896): the snapshot would carry empty stand-ins for everything not
 *    yet loaded. The one exception is a seed that brought the whole
 *    composition with it (an offline send brought back by undo), which may be
 *    queued again while still offline, as before.
 *
 * Refusals throw `SurfacedOperationError`: the operation that failed has
 * already toasted, and the composer's own notice explains the rest, so the
 * host's catch must not add a third message.
 */

import type { Ref } from 'vue';
import type { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { OperationError } from '@owlat/shared/operationError';
import type { BackendOperation, BackendOperationResult } from '~/composables/useBackendOperation';
import { SurfacedOperationError } from '~/lib/operationError';
import type { SettleOutcome } from './usePostboxComposeAutosave';
import type { InitialHydrationState } from './usePostboxComposeHydration';
import type { SendOpts } from './usePostboxComposeOfflineSend';

/** Why the composer is refusing to persist or send right now. */
export type ComposeDraftNotice =
	| 'loading'
	| 'load_failed'
	/** The draft is gone, or this member can no longer open it. */
	| 'missing'
	/** The latest changes did not save, so Send stopped. */
	| 'not_sent'
	/** The latest changes did not save (the move to Answer mode, the seal re-check). */
	| 'not_saved'
	/** Every save landed, but the fields kept changing under them. */
	| 'still_changing';

type SendReceipt = { undoToken: string; sendAt: number };

/**
 * While a send step is in progress, a TRANSPORT failure of any operation it
 * runs is claimed (no error toast) so the send can queue offline instead. Every
 * other category, and every failure outside a send, keeps the standard
 * treatment. Created before the operations, which take `claim` as `onError`.
 */
export function createSendNetworkClaim() {
	let intercepting = false;
	let failed = false;
	return {
		claim(op: OperationError): boolean {
			if (!intercepting || op.category !== 'network') return false;
			failed = true;
			return true;
		},
		/**
		 * Forget a failure claimed earlier in this step. For a step that first
		 * waits on someone else's operation and then runs its own.
		 */
		reset() {
			failed = false;
		},
		/** Run one step, reporting whether the connection failed under it. */
		async intercept<T>(run: () => Promise<T>): Promise<{ value: T; networkFailed: boolean }> {
			intercepting = true;
			failed = false;
			try {
				const value = await run();
				return { value, networkFailed: failed };
			} finally {
				intercepting = false;
			}
		},
	};
}

interface ComposeSendOptions {
	initialHydration: Ref<InitialHydrationState>;
	/** The seed carried recipients, subject and body: queueable before the row loads. */
	seedCarriesComposition: boolean;
	isOffline: Readonly<Ref<boolean>>;
	lastSavedAt: Ref<number | null>;
	network: ReturnType<typeof createSendNetworkClaim>;
	settlePendingSave: (beforeWrite?: () => void) => Promise<SettleOutcome<Id<'mailDrafts'>>>;
	flushSave: () => Promise<SettleOutcome<Id<'mailDrafts'> | null>>;
	sendDraft: BackendOperation<typeof api.mail.drafts.send>;
	/** The complete-payload offline queue; throws when the device cannot store it. */
	queueOfflineSend: (opts?: SendOpts) => Promise<SendReceipt>;
	/** Tombstone the recovery mirror: the composition has left the composer. */
	retireMirror: () => void;
	armUndo: (sent: SendReceipt) => SendReceipt;
	undoSendDelayMs: () => number | undefined;
}

export function usePostboxComposeSend(o: ComposeSendOptions) {
	const persistRefusal = ref<'not_sent' | 'not_saved' | 'still_changing' | null>(null);
	// The server has the text now; whatever was refused before no longer applies.
	watch(o.lastSavedAt, () => {
		persistRefusal.value = null;
	});

	const draftNotice = computed<ComposeDraftNotice | null>(() => {
		if (o.initialHydration.value === 'error') return 'load_failed';
		if (o.initialHydration.value === 'missing') return 'missing';
		if (o.initialHydration.value === 'loading') return 'loading';
		return persistRefusal.value;
	});

	/** Whether a send may be attempted right now (a gate for `canSend`). */
	// A missing draft sends nothing, not even a seeded composition queued
	// offline: the drain would replay it onto a row that is gone.
	const sendReady = computed(
		() =>
			o.initialHydration.value === 'ready' ||
			(o.initialHydration.value !== 'missing' && o.seedCarriesComposition && o.isOffline.value)
	);

	/**
	 * Hand the composition to the on-device outbox and retire its mirror.
	 *
	 * The queued payload is a COMPLETE copy of the text (undo hands the whole
	 * thing back), so the mirror has nothing left to protect — and leaving it
	 * would be actively wrong: a fresh compose mirrors under a shared
	 * provisional key, so the next blank compose would be offered "Restore
	 * unsaved changes" holding a message that is already queued, one click from
	 * sending it twice. Only reached on a successful queue: `queueOfflineSend`
	 * throws when the device could not store the payload, and that message still
	 * lives in the composer, and no undo window is armed for it.
	 */
	async function queueSendOffline(opts?: SendOpts) {
		const queued = await o.queueOfflineSend(opts);
		o.retireMirror();
		return o.armUndo(queued);
	}

	async function send(opts?: SendOpts): Promise<SendReceipt> {
		persistRefusal.value = null;
		// The loading / load-failed notice is already on screen.
		if (!sendReady.value) throw new SurfacedOperationError('Draft not loaded');
		// Offline never touches the network — queue the payload on-device.
		if (o.isOffline.value) return queueSendOffline(opts);

		// A debounced save still in flight may fail on the transport; only the
		// outcome of the write made for this send decides between the offline
		// queue and a refusal.
		const save = await o.network.intercept(() => o.settlePendingSave(() => o.network.reset()));
		const saved = save.value;
		if (!saved.ok) {
			// The connection dropped under the save (or the row's creation): the
			// payload carries the current text, so queue it.
			if (save.networkFailed) return queueSendOffline(opts);
			persistRefusal.value = 'stillChanging' in saved ? 'still_changing' : 'not_sent';
			throw new SurfacedOperationError('Draft not saved');
		}

		const sent = await o.network.intercept(() =>
			o.sendDraft.run({
				draftId: saved.result,
				// An explicit per-send window (the offline drain, tests) wins; with
				// none, the user's preference decides. On the default window that
				// resolves back to `undefined` and the server's own default applies.
				undoSendDelayMs: opts?.undoSendDelayMs ?? o.undoSendDelayMs(),
				scheduledSendAt: opts?.scheduledSendAt,
				allowUnsealed: opts?.allowUnsealed,
			})
		);
		// `useBackendOperation.run` swallows categorized failures (it has already
		// toasted them). Surface that as a throw so undo is never armed and the
		// host never moves on after a failed send — unless the failure was the
		// TRANSPORT, in which case the message queues offline.
		if (!sent.value.ok) {
			if (sent.networkFailed) return queueSendOffline(opts);
			throw new SurfacedOperationError('Send failed');
		}
		// It is on the wire (or queued behind the undo window) — the mirror has
		// nothing left to protect, and must not resurface on a reopened draft.
		o.retireMirror();
		return o.armUndo(sent.value.result as SendReceipt);
	}

	/**
	 * Save the current snapshot and hand back the row id, for a popup reply
	 * moving to Answer mode (which reopens the SAME row), Answer mode's own
	 * saves, and the seal re-check.
	 * `ok: false` means nothing may be assumed saved; the reason is on screen.
	 */
	async function flush(): Promise<BackendOperationResult<Id<'mailDrafts'> | null>> {
		persistRefusal.value = null;
		if (o.initialHydration.value !== 'ready') return { ok: false };
		const saved = await o.flushSave();
		if (saved.ok) return saved;
		persistRefusal.value = 'stillChanging' in saved ? 'still_changing' : 'not_saved';
		return { ok: false };
	}

	return { send, flush, sendReady, draftNotice };
}
