/**
 * Compose draft state machine with debounced autosave.
 *
 * Lifecycle:
 *   - ensureDraft() creates a draft row server-side if missing
 *   - any field change triggers a 1.5s-debounced upsert via update()
 *   - send() requires the server to have acknowledged the current snapshot
 *     (retrying a failed save once), then invokes mailDrafts.send (which
 *     schedules dispatch after undoSendDelayMs); a save that still fails
 *     sends nothing
 *   - a reopened draft writes and sends nothing until its row has loaded;
 *     edits made meanwhile are merged over it (usePostboxComposeHydration)
 *   - offline (or a send that network-fails), send() instead queues the full
 *     compose payload in the on-device outbox and returns a synthetic
 *     {undoToken, sendAt}; the undo toast un-queues via the token
 *   - either way, a send that went out (or was queued) arms the undo window
 *     here, so no host has to remember it
 */

import type { FunctionReturnType } from 'convex/server';
import type { OperationError } from '@owlat/shared/operationError';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { EditorBlock } from '@owlat/email-builder';
import type { MailboxComposerTarget } from '~/utils/composerTarget';
import { postboxUndoSendDelayMsArg } from '~/utils/postboxUndoSendWindow';
import { freshDraftGaps, isDraftGapsRefusal } from '~/utils/answerDraft';
import {
	usePostboxComposeAttachments,
	type ComposerAttachment,
} from './usePostboxComposeAttachments';
import { usePostboxComposeAutosave } from './usePostboxComposeAutosave';
import { expectedAttachmentRequests, type GeneratedAttachment } from './usePostboxComposeExpected';
import type { InitialHydrationState } from './usePostboxComposeHydration';
import { usePostboxComposeMirror } from './usePostboxComposeMirror';
import {
	usePostboxComposeRow,
	usePostboxComposeSeedTouched,
	type BeforeReady,
} from './usePostboxComposeRow';
import { usePostboxComposeOfflineSend } from './usePostboxComposeOfflineSend';
import { createSendNetworkClaim, usePostboxComposeSend } from './usePostboxComposeSend';
import { usePostboxComposeSignatures } from './usePostboxComposeSignatures';
import { usePostboxOfflineOutbox } from './usePostboxOfflineOutbox';
import { usePostboxSettings } from './usePostboxSettings';
import { usePostboxUndoSend } from './usePostboxUndoSend';

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

/**
 * The one-time seed a composer opens with: the one declaration every host
 * writes (the compose page's ComposeSpec, Answer mode's seed, the
 * desktop compose window) and PostboxComposer hands over whole.
 *
 * Where it writes is a mailbox composer target (`utils/composerTarget`): the
 * seed carries that target's fields (`mailboxId`, and `draftId` to reopen a
 * draft or `inReplyToMessageId` for a reply) beside what to pre-fill, and
 * `mailboxComposerTarget(seed)` names it.
 */
export interface ComposerSeed extends Omit<MailboxComposerTarget, 'kind'> {
	prefillTo?: string[];
	prefillCc?: string[];
	prefillBcc?: string[];
	prefillSubject?: string;
	prefillBodyHtml?: string;
	/**
	 * Attachment refs already committed to `draftId`, shown immediately instead
	 * of waiting for the draft row. Used when undo un-queues an offline send:
	 * the draft is unreachable while offline, so the refs come from the queued
	 * payload (usePostboxOfflineOutbox).
	 */
	prefillAttachments?: ComposerAttachment[];
	/** Forward: the new row owes this message's parts (those named, else every file part). */
	forwardAttachmentsFromMessageId?: Id<'mailMessages'>;
	forwardAttachmentParts?: Array<{ partIndex: string; filename: string }>;
	/** Attach a file the app generated (an RSVP reply); the new row owes it until then. */
	attachGenerated?: GeneratedAttachment;
	/** Full-mode blocks, the editor mode and the reminder, for a seed carrying a whole composition. */
	prefillBodyBlocks?: EditorBlock[];
	prefillComposerMode?: ComposerMode;
	prefillFollowUpRemindAt?: number | null;
	/**
	 * The compose request's creation nonce (the compose page's `?c=`): a remount
	 * of the same request gets the same row back instead of creating another.
	 */
	requestNonce?: string;
}

/** Options a host passes beside the seed. */
export interface ComposeOptions {
	/** The compose page applies or offers text it parked on a leave. */
	beforeReady?: BeforeReady;
}

export function usePostboxCompose(seed: ComposerSeed, options: ComposeOptions = {}) {
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
	const bodyBlocks = ref<EditorBlock[]>(seed.prefillBodyBlocks ?? []); // used in 'full' mode
	const composerMode = ref<ComposerMode>(seed.prefillComposerMode ?? 'simple');
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
	const followUpRemindAt = ref<number | null>(seed.prefillFollowUpRemindAt ?? null);
	// The AI left `[[...]]` gaps in this draft before (from the saved row).
	const isGapGuarded = ref(false);
	// A reopened draft's fields start empty and fill in when `drafts.get`
	// answers; until then nothing may write or send the snapshot (#896).
	const initialHydration = ref<InitialHydrationState>(seed.draftId ? 'loading' : 'ready');
	// The body editor is withheld until then too, unless the seed brought the
	// body: typing into an empty-looking editor would replace a saved body the
	// user never saw, which the merge cannot tell from an intended rewrite.
	const bodyPending = computed(
		() => initialHydration.value !== 'ready' && seed.prefillBodyHtml === undefined
	);

	// Offline outbox: send() queues instead of failing while offline; the
	// drain replays queued payloads on reconnect (usePostboxOfflineOutbox).
	const offlineOutbox = usePostboxOfflineOutbox(() => String(seed.mailboxId));

	// Undo-send window. The per-user preference decides how long a
	// send is held; `postboxUndoSendDelayMsArg` returns undefined on the default
	// window, so a user who never touched the setting still sends the exact
	// mutation args this composable sent before the preference existed.
	const { undoSendSeconds } = usePostboxSettings();
	const undoSendDelayMs = computed(() => postboxUndoSendDelayMsArg(undoSendSeconds.value));
	// The toast the send arms (shared state, rendered by whichever host mounts
	// PostboxUndoSendToast). Arming lives here, at the one place a send
	// completes, so every host gets the toast and the send sound.
	const undoWindow = usePostboxUndoSend();
	function armUndo(sent: { undoToken: string; sendAt: number }) {
		undoWindow.arm({
			...sent,
			mailboxId: seed.mailboxId,
			replyToMessageId: seed.inReplyToMessageId,
		});
		return sent;
	}
	// During a send, a TRANSPORT failure becomes an offline enqueue.
	const sendNetwork = createSendNetworkClaim();

	const createDraft = useBackendOperation(api.mail.drafts.create, {
		label: () => t('shared.postbox.usePostboxCompose.createOperation'),
		onError: sendNetwork.claim,
	});
	const updateDraft = useBackendOperation(api.mail.drafts.update, {
		label: () => t('shared.postbox.usePostboxCompose.saveOperation'),
		onError: sendNetwork.claim,
	});
	const setIdentityMutation = useBackendOperation(api.mail.drafts.setIdentity, {
		label: () => t('shared.postbox.usePostboxCompose.setIdentityOperation'),
	});
	const discardDraft = useBackendOperation(api.mail.drafts.discard, {
		label: () => t('shared.postbox.usePostboxCompose.discardOperation'),
	});
	// An AI draft with a `[[...]]` gap left: Send is disabled for that already,
	// so this is a race (a gap typed in the last moment); say it the same way.
	const { showToast } = useToast();
	const claimGapRefusal = (op: OperationError): boolean => {
		if (!isDraftGapsRefusal(op)) return false;
		const count = Math.max(1, freshDraftGaps(bodyHtml.value).length);
		showToast(t('components.postbox.postboxComposerFooter.gapsLeft', { count }, count), 'error');
		return true;
	};
	const sendDraft = useBackendOperation(api.mail.drafts.send, {
		label: () => t('shared.postbox.usePostboxCompose.sendOperation'),
		onError: (op) => sendNetwork.claim(op) || claimGapRefusal(op),
	});
	const cancelPending = useBackendOperation(api.mail.drafts.cancelPendingSend, {
		label: () => t('shared.postbox.usePostboxCompose.undoSendOperation'),
	});
	const cancelScheduled = useBackendOperation(api.mail.drafts.cancelScheduledSend, {
		label: () => t('shared.postbox.usePostboxCompose.cancelScheduledOperation'),
	});

	// Which fields the person set during this mount (shared by hydration, row
	// creation, the mirror's Restore and the compose page's parking).
	const touched = usePostboxComposeSeedTouched(seed, {
		toAddresses,
		ccAddresses,
		bccAddresses,
		subject,
		bodyHtml,
		bodyBlocks,
		composerMode,
		followUpRemindAt,
	});

	const expectedAttachments = expectedAttachmentRequests(seed);
	// Draft row creation + the 1.5s-debounced autosave live in a sibling
	// composable. Everything below drives the SAME row through `ensureDraft`.
	const autosave = usePostboxComposeAutosave({
		mailboxId: seed.mailboxId,
		inReplyToMessageId: seed.inReplyToMessageId,
		draftId,
		draftState,
		initialHydration,
		ensuring,
		isSaving,
		lastSavedAt,
		touched,
		requestNonce: seed.requestNonce,
		expectedAttachments,
		onReopenExisting: () => row.reopenExisting(),
		onGone: () => {
			initialHydration.value = 'missing';
		},
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
	});
	const { ensureDraft, cancelAutosave } = autosave;
	// Uploads, the generated file and forward copies: a sibling on the same draft.
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
		bodyLocked: () => bodyPending.value,
		expectedAttachments,
		rowState: () => initialHydration.value,
	});

	// Reopening an offline-queued send (undo un-queued it) carries the payload's
	// committed attachment refs: while offline the draft row is unreachable, so
	// hydration cannot restore them and a re-send would re-queue a payload with
	// its attachments silently dropped. A ref only exists once it was committed
	// to a server draft, so such a seed always carries that `draftId` too — the
	// re-send reuses the row the files already live on.
	if (seed.prefillAttachments?.length) attachments.value = [...seed.prefillAttachments];

	// The row: a reopened draft is merged into the editor, and every row the
	// composer has is observed for as long as it is open (lifecycle, mirror).
	const row = usePostboxComposeRow(
		seed,
		draftId,
		initialHydration,
		{
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
			isGapGuarded,
		},
		touched,
		options.beforeReady,
		(snapshot) => autosave.persistRestored(snapshot)
	);

	// Plan idea 7: mirror these exact fields on-device between server autosaves,
	// and offer them back when a crash or a failed save left the row behind.
	const draftMirror = usePostboxComposeMirror({
		mailboxId: seed.mailboxId,
		draftId,
		inReplyToMessageId: seed.inReplyToMessageId,
		ready: computed(() => initialHydration.value === 'ready'),
		draftState,
		latestRow: row.latestRow,
		touched,
		toAddresses,
		ccAddresses,
		bccAddresses,
		subject,
		bodyHtml,
		bodyBlocks,
		composerMode,
		followUpRemindAt,
		autosave,
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
		bodyLocked: () => bodyPending.value,
		canPrepend: () => initialHydration.value === 'ready' && !draftId.value,
		applying: touched.applying,
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
		cancelAutosave,
		queue: (payload, delay) => offlineOutbox.queueSend(payload, delay),
		undoSendDelayMs: () => undoSendDelayMs.value,
	});

	const { send, flush, sendReady, draftNotice } = usePostboxComposeSend({
		initialHydration,
		// The offline-undo seed: the whole composition, newer than the row.
		seedCarriesComposition:
			seed.prefillTo !== undefined &&
			seed.prefillSubject !== undefined &&
			seed.prefillBodyHtml !== undefined,
		isOffline: offlineOutbox.isOffline,
		lastSavedAt,
		network: sendNetwork,
		settlePendingSave: autosave.settlePendingSave,
		flushSave: autosave.flush,
		sendDraft,
		queueOfflineSend,
		retireMirror: () => draftMirror.retire(),
		armUndo,
		undoSendDelayMs: () => undoSendDelayMs.value,
	});

	const canSend = computed(() => {
		// Never let a send fire while an attachment is still on its way to the row
		// (an upload in flight, a file the draft owes): it would go out without it.
		if (isUploading.value) return false;
		// A reopened draft that has not loaded would send (or queue) a snapshot
		// of empty stand-ins; the draft notice says why Send is waiting.
		if (!sendReady.value) return false;
		if (toAddresses.value.length === 0) return false;
		if (subject.value.trim().length > 0) return true;
		if (attachments.value.length > 0) return true;
		if (composerMode.value === 'full') return bodyBlocks.value.length > 0;
		// Strip HTML tags before measuring length so an empty <p></p>
		// from the contenteditable doesn't count as content.
		const plain = bodyHtml.value.replace(/<[^>]+>/g, '').trim();
		return plain.length > 0;
	});

	async function discard() {
		cancelAutosave();
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
		draftNotice,
		bodyPending,
		retryLoad: () => row.hydration.retry(),
		parkable: row.parkable,
		onCreated: autosave.onCreated,
		isGapGuarded,
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
