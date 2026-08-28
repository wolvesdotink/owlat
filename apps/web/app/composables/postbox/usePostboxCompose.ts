/**
 * Compose draft state machine with debounced autosave.
 *
 * Lifecycle:
 *   - ensureDraft() creates a draft row server-side if missing
 *   - any field change triggers a 1.5s-debounced upsert via update()
 *   - send() flushes pending autosave first, then invokes mailDrafts.send
 *     (which schedules dispatch after undoSendDelayMs)
 *   - offline (or a send that network-fails), send() instead queues the full
 *     compose payload in the on-device outbox and returns a synthetic
 *     {undoToken, sendAt} — the emit contract is unchanged, and the undo
 *     toast un-queues via the token (adoption-gaps D8)
 */

import type { FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { EditorBlock } from '@owlat/email-builder';
import type { OperationError } from '@owlat/shared/operationError';
import { SurfacedOperationError } from '~/lib/operationError';
import { postboxUndoSendDelayMsArg } from '~/utils/postboxUndoSendWindow';
import {
	usePostboxComposeAttachments,
	type ComposerAttachment,
} from './usePostboxComposeAttachments';
import { usePostboxComposeHydration } from './usePostboxComposeHydration';
import { usePostboxComposeMirror } from './usePostboxComposeMirror';
import { usePostboxComposeOfflineSend, type SendOpts } from './usePostboxComposeOfflineSend';
import { usePostboxComposeSignatures } from './usePostboxComposeSignatures';
import { usePostboxOfflineOutbox } from './usePostboxOfflineOutbox';
import { usePostboxSettings } from './usePostboxSettings';

const AUTOSAVE_DEBOUNCE_MS = 1500;

export type ComposerMode = 'simple' | 'full';

/**
 * A From identity the composer may send as. Derived straight from the backend
 * query's return so the client shape can never drift from the server's.
 * `kind` drives the picker grouping: 'team'/'own' is the current mailbox's own
 * identity; 'personal' is a teammate's own address offered inside a team inbox.
 */
export type SendAsIdentity = FunctionReturnType<
	typeof api.mail.identities.listSendAsIdentities
>[number];

interface DraftSeed {
	mailboxId: Id<'mailboxes'>;
	/** Reopen an existing draft (continue editing / after undo-send). */
	draftId?: Id<'mailDrafts'>;
	inReplyToMessageId?: Id<'mailMessages'>;
	prefillTo?: string[];
	prefillCc?: string[];
	prefillBcc?: string[];
	prefillSubject?: string;
	prefillBodyHtml?: string;
	/** Attachment refs already committed to `draftId` (see ComposerSpec). */
	prefillAttachments?: ComposerAttachment[];
	forwardAttachmentsFromMessageId?: Id<'mailMessages'>;
	attachPendingKey?: string;
	initialMode?: ComposerMode;
}

export function usePostboxCompose(seed: DraftSeed) {
	const { t } = useI18n();
	const draftId = ref<Id<'mailDrafts'> | null>(seed.draftId ?? null);
	const ensuring = ref(false);
	const isSaving = ref(false);
	const lastSavedAt = ref<number | null>(null);

	const toAddresses = ref<string[]>(seed.prefillTo ?? []);
	const ccAddresses = ref<string[]>(seed.prefillCc ?? []);
	const bccAddresses = ref<string[]>(seed.prefillBcc ?? []);
	const subject = ref<string>(seed.prefillSubject ?? '');
	// A reply/forward seeds the quoted original here; the user types above it.
	const bodyHtml = ref<string>(seed.prefillBodyHtml ?? '');
	const bodyBlocks = ref<EditorBlock[]>([]); // EditorBlock[] in 'full' mode
	const composerMode = ref<ComposerMode>(seed.initialMode ?? 'simple');
	const fromAddress = ref<string>('');
	// Lifecycle state of the saved row. A reopened draft can be 'scheduled'
	// (a future send the user wants to review). While scheduled, autosave is
	// suppressed — drafts.update rejects non-'draft' rows — and the editor is
	// gated behind an explicit unschedule (mirrors campaigns' Unschedule-to-Edit).
	const draftState = ref<'draft' | 'pending_send' | 'scheduled'>('draft');
	const scheduledSendAt = ref<number | null>(null);
	const isScheduled = computed(() => draftState.value === 'scheduled');
	// "Remind me if no reply by…" — persisted on the draft and carried onto the
	// sent thread as a follow-up watch (mail/followUps.ts). null = off.
	const followUpRemindAt = ref<number | null>(null);

	// Offline outbox (D8): send() queues instead of failing while offline; the
	// drain replays queued payloads on reconnect (usePostboxOfflineOutbox).
	const offlineOutbox = usePostboxOfflineOutbox(() => String(seed.mailboxId));

	// Undo-send window (plan idea 8). The per-user preference decides how long a
	// send is held; `postboxUndoSendDelayMsArg` returns undefined on the default
	// window, so a user who never touched the setting still sends the exact
	// mutation args this composable sent before the preference existed.
	const { undoSendSeconds } = usePostboxSettings();
	const undoSendDelayMs = computed(() => postboxUndoSendDelayMsArg(undoSendSeconds.value));
	// While send() is actively intercepting, a TRANSPORT failure is claimed
	// (no error toast) and turned into an offline enqueue instead. Every other
	// category, and every failure outside a send, keeps today's treatment.
	let interceptingSend = false;
	let sendNetworkFailed = false;
	const claimSendNetworkFailure = (op: OperationError): boolean => {
		if (!interceptingSend || op.category !== 'network') return false;
		sendNetworkFailed = true;
		return true;
	};

	const createDraft = useBackendOperation(api.mail.drafts.create, {
		label: () => t('shared.postbox.usePostboxCompose.createOperation'),
		onError: claimSendNetworkFailure,
	});
	const updateDraft = useBackendOperation(api.mail.drafts.update, {
		label: () => t('shared.postbox.usePostboxCompose.saveOperation'),
		onError: claimSendNetworkFailure,
	});
	const setIdentityMutation = useBackendOperation(api.mail.drafts.setIdentity, {
		label: () => t('shared.postbox.usePostboxCompose.setIdentityOperation'),
	});
	const discardDraft = useBackendOperation(api.mail.drafts.discard, {
		label: () => t('shared.postbox.usePostboxCompose.discardOperation'),
	});
	const sendDraft = useBackendOperation(api.mail.drafts.send, {
		label: () => t('shared.postbox.usePostboxCompose.sendOperation'),
		onError: claimSendNetworkFailure,
	});
	const cancelPending = useBackendOperation(api.mail.drafts.cancelPendingSend, {
		label: () => t('shared.postbox.usePostboxCompose.undoSendOperation'),
	});
	const cancelScheduled = useBackendOperation(api.mail.drafts.cancelScheduledSend, {
		label: () => t('shared.postbox.usePostboxCompose.cancelScheduledOperation'),
	});
	// Attachment upload/remove + pending-handoff + forward-clone live in a
	// sibling composable; it drives the same draft via ensureDraft/draftId.
	const {
		attachments,
		uploads,
		isUploading,
		attachmentSizeMeter,
		thumbUrlFor,
		addFiles,
		removeAttachment,
		shareAsLink,
		isSharing,
		cancelUpload,
		retryUpload,
		addInlineImage,
		removeInlineImage,
	} = usePostboxComposeAttachments({
		ensureDraft,
		draftId,
		// "Share as link instead" (idea 10) takes the file out of the message and
		// puts a link block in the body, so it needs the very ref this composable
		// autosaves — otherwise the swap would drop the attachment and leave the
		// recipient with no way to reach it.
		bodyHtml,
		attachPendingKey: seed.attachPendingKey,
		forwardAttachmentsFromMessageId: seed.forwardAttachmentsFromMessageId,
	});

	// Reopening an offline-queued send (undo un-queued it) carries the payload's
	// committed attachment refs: while offline the draft row is unreachable, so
	// hydration cannot restore them and a re-send would re-queue a payload with
	// its attachments silently dropped. A ref only exists once it was committed
	// to a server draft, so such a seed always carries that `draftId` too — the
	// re-send reuses the row the files already live on.
	if (seed.prefillAttachments?.length) attachments.value = [...seed.prefillAttachments];

	// Reopen an existing draft: hydrate the editor fields from the saved row.
	if (seed.draftId) {
		usePostboxComposeHydration(seed.draftId, {
			toAddresses,
			ccAddresses,
			bccAddresses,
			subject,
			bodyHtml,
			bodyBlocks,
			fromAddress,
			composerMode,
			draftState,
			scheduledSendAt,
			followUpRemindAt,
			attachments,
			lastSavedAt,
		});
	}

	// Plan idea 7: mirror these exact fields on-device between server autosaves,
	// and offer them back when a crash left the server row behind.
	const draftMirror = usePostboxComposeMirror({
		mailboxId: seed.mailboxId,
		seedDraftId: seed.draftId,
		inReplyToMessageId: seed.inReplyToMessageId,
		draftId,
		lastSavedAt,
		draftState,
		toAddresses,
		ccAddresses,
		bccAddresses,
		subject,
		bodyHtml,
		bodyBlocks,
		composerMode,
	});

	// Send-as identities for this mailbox: the mailbox's own allowed-from set
	// (canonical address + active aliases) and, in a shared (team) inbox, the
	// acting teammate's personal identities from their own mailboxes. The server
	// is the source of truth — the picker is just UI, and every candidate is
	// re-validated on setIdentity + at dispatch.
	const identitiesQuery = useConvexQuery(api.mail.identities.listSendAsIdentities, () => ({
		mailboxId: seed.mailboxId,
	}));
	const availableIdentities = computed<SendAsIdentity[]>(() => identitiesQuery.data.value ?? []);

	async function setIdentity(address: string) {
		const id = await ensureDraft();
		if (!id) return;
		const result = await setIdentityMutation.run({ draftId: id, fromAddress: address });
		if (!result.ok) return;
		fromAddress.value = address.trim().toLowerCase();
	}

	// Signature selection + the fresh-compose auto-prepend live in a sibling
	// composable; it edits the same `bodyHtml` this composable autosaves.
	const { signatures, activeSignatureId, applySignature } = usePostboxComposeSignatures({
		mailboxId: seed.mailboxId,
		bodyHtml,
		isReopenedDraft: Boolean(seed.draftId),
	});

	async function ensureDraft(): Promise<Id<'mailDrafts'> | null> {
		if (draftId.value) return draftId.value;
		if (ensuring.value) return null;
		ensuring.value = true;
		try {
			const result = await createDraft.run({
				mailboxId: seed.mailboxId,
				inReplyToMessageId: seed.inReplyToMessageId,
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

	const canSend = computed(() => {
		// Never let a send fire while an attachment upload is still in flight: the
		// draft's `attachments` array has not yet committed the pending file, so a
		// mid-upload send would silently drop it from the outgoing message. Mirror
		// the chat composer (ChatInput), which gates its Send on `!isUploading`.
		if (isUploading.value) return false;
		if (toAddresses.value.length === 0) return false;
		if (subject.value.trim().length > 0) return true;
		if (attachments.value.length > 0) return true;
		if (composerMode.value === 'full') return bodyBlocks.value.length > 0;
		// Strip HTML tags before measuring length so an empty <p></p>
		// from the contenteditable doesn't count as content.
		const plain = bodyHtml.value.replace(/<[^>]+>/g, '').trim();
		return plain.length > 0;
	});

	// The offline queue's payload builder lives in a sibling (file-size ratchet);
	// it snapshots these exact refs, so nothing here needs to change on a send.
	const queueOfflineSend = usePostboxComposeOfflineSend({
		mailboxId: seed.mailboxId,
		inReplyToMessageId: seed.inReplyToMessageId,
		draftId,
		toAddresses,
		ccAddresses,
		bccAddresses,
		subject,
		bodyHtml,
		bodyBlocks,
		composerMode,
		fromAddress,
		followUpRemindAt,
		attachments,
		cancelAutosave: () => {
			if (saveTimer) {
				clearTimeout(saveTimer);
				saveTimer = null;
			}
		},
		queue: (payload, delay) => offlineOutbox.queueSend(payload, delay),
		undoSendDelayMs: () => undoSendDelayMs.value,
	});

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
	 * lives in the composer.
	 */
	async function queueSendOffline(opts?: SendOpts) {
		const queued = await queueOfflineSend(opts);
		draftMirror.retire();
		return queued;
	}

	async function send(opts?: SendOpts) {
		// D8: offline never touches the network — queue the payload on-device.
		if (offlineOutbox.isOffline.value) return queueSendOffline(opts);

		interceptingSend = true;
		sendNetworkFailed = false;
		try {
			// Flush any pending autosave first
			if (saveTimer) {
				clearTimeout(saveTimer);
				saveTimer = null;
				pendingSave = persist();
			}
			if (pendingSave) await pendingSave;

			const id = await ensureDraft();
			if (!id) {
				// The draft row couldn't be created because the connection dropped
				// mid-send — queue instead of losing the message.
				if (sendNetworkFailed) return queueSendOffline(opts);
				throw new Error('No draft');
			}

			const result = await sendDraft.run({
				draftId: id,
				// An explicit per-send window (the offline drain, tests) wins; with
				// none, the user's preference decides. On the default window that
				// resolves back to `undefined` and the server's own default applies.
				undoSendDelayMs: opts?.undoSendDelayMs ?? undoSendDelayMs.value,
				scheduledSendAt: opts?.scheduledSendAt,
				allowUnsealed: opts?.allowUnsealed,
			});
			// `useBackendOperation.run` swallows categorized failures (it has already
			// toasted them) and returns `undefined`. Surface that as a throw so the
			// caller never arms undo / navigates away on a failed send — unless the
			// failure was the TRANSPORT, in which case the message queues offline.
			if (!result.ok) {
				if (sendNetworkFailed) return queueSendOffline(opts);
				// Already toasted by the operation module — the throw exists only so
				// the caller does not treat a refusal as a send.
				throw new SurfacedOperationError('Send failed');
			}
			// It is on the wire (or queued behind the undo window) — the mirror has
			// nothing left to protect, and must not resurface on a reopened draft.
			draftMirror.retire();
			return result.result as { undoToken: string; sendAt: number };
		} finally {
			interceptingSend = false;
		}
	}

	async function discard() {
		if (saveTimer) clearTimeout(saveTimer);
		// A deliberate throw-away: tombstone the mirror so nothing offers this
		// text back on a later open (and an already-debounced write no-ops).
		draftMirror.retire();
		if (draftId.value) {
			const result = await discardDraft.run({ draftId: draftId.value });
			if (!result.ok) return;
			draftId.value = null;
		}
	}

	/**
	 * Unschedule a future send and return the draft to editable 'draft' state.
	 * Reuses the live `draftId` (the undo token isn't available days out from a
	 * scheduled send). On success the local state flips back to 'draft', which
	 * re-enables autosave and the editor.
	 */
	async function cancelSchedule() {
		const id = draftId.value;
		if (!id) return false;
		const result = await cancelScheduled.run({ draftId: id });
		if (!result.ok || !result.result.ok) return false;
		draftState.value = 'draft';
		scheduledSendAt.value = null;
		return true;
	}

	async function undoSend(undoToken: string) {
		const result = await cancelPending.run({ undoToken });
		if (result.ok && result.result.ok) {
			draftId.value = (result.result.draftId as Id<'mailDrafts'>) ?? draftId.value;
		}
		return result.ok ? result.result : undefined;
	}

	return {
		draftId,
		toAddresses,
		ccAddresses,
		bccAddresses,
		subject,
		bodyHtml,
		bodyBlocks,
		composerMode,
		fromAddress,
		availableIdentities,
		setIdentity,
		signatures,
		activeSignatureId,
		applySignature,
		attachments,
		uploads,
		isUploading,
		attachmentSizeMeter,
		thumbUrlFor,
		addFiles,
		removeAttachment,
		shareAsLink,
		isSharing,
		cancelUpload,
		retryUpload,
		addInlineImage,
		removeInlineImage,
		isSaving,
		lastSavedAt,
		draftMirror,
		canSend,
		isScheduled,
		scheduledSendAt,
		cancelSchedule,
		followUpRemindAt,
		ensureDraft,
		flush,
		send,
		discard,
		undoSend,
	};
}
