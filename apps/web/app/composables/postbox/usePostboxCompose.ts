/**
 * Compose draft state machine with debounced autosave.
 *
 * Lifecycle:
 *   - ensureDraft() creates a draft row server-side if missing
 *   - any field change triggers a 1.5s-debounced upsert via update()
 *   - send() flushes pending autosave first, then invokes mailDrafts.send
 *     (which schedules dispatch after undoSendDelayMs)
 */

import type { FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { EditorBlock } from '@owlat/email-builder';
import { usePostboxComposeAttachments } from './usePostboxComposeAttachments';
import { applySignatureToBody, wrapSignatureBlock } from './usePostboxSignatureBody';

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
	forwardAttachmentsFromMessageId?: Id<'mailMessages'>;
	attachPendingKey?: string;
	initialMode?: ComposerMode;
}

export function usePostboxCompose(seed: DraftSeed) {
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

	const createDraft = useBackendOperation(api.mail.drafts.create, {
		label: 'Create draft',
	});
	const updateDraft = useBackendOperation(api.mail.drafts.update, {
		label: 'Save draft',
	});
	const setIdentityMutation = useBackendOperation(api.mail.drafts.setIdentity, {
		label: 'Change sender',
	});
	const discardDraft = useBackendOperation(api.mail.drafts.discard, {
		label: 'Discard draft',
	});
	const sendDraft = useBackendOperation(api.mail.drafts.send, {
		label: 'Send email',
	});
	const cancelPending = useBackendOperation(api.mail.drafts.cancelPendingSend, {
		label: 'Undo send',
	});
	const cancelScheduled = useBackendOperation(api.mail.drafts.cancelScheduledSend, {
		label: 'Cancel scheduled send',
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
		cancelUpload,
		retryUpload,
		addInlineImage,
		removeInlineImage,
	} = usePostboxComposeAttachments({
		ensureDraft,
		draftId,
		attachPendingKey: seed.attachPendingKey,
		forwardAttachmentsFromMessageId: seed.forwardAttachmentsFromMessageId,
	});

	// Reopen an existing draft: hydrate the editor fields from the saved row.
	if (seed.draftId) {
		const hydrateQuery = useConvexQuery(api.mail.drafts.get, () => ({
			draftId: seed.draftId as Id<'mailDrafts'>,
		}));
		let hydrated = false;
		watch(
			() => hydrateQuery.data.value,
			(d) => {
				if (hydrated || !d) return;
				hydrated = true;
				const draft = d as {
					toAddresses?: string[];
					ccAddresses?: string[];
					bccAddresses?: string[];
					subject?: string;
					bodyHtml?: string;
					bodyBlocks?: string;
					fromAddress?: string;
					composerMode?: ComposerMode;
					state?: 'draft' | 'pending_send' | 'scheduled';
					scheduledSendAt?: number;
					followUpRemindAt?: number;
					attachments?: Array<{
						storageId: string;
						filename: string;
						contentType: string;
						size: number;
					}>;
				};
				draftState.value = draft.state ?? 'draft';
				scheduledSendAt.value = draft.scheduledSendAt ?? null;
				if (followUpRemindAt.value === null) {
					followUpRemindAt.value = draft.followUpRemindAt ?? null;
				}
				// Fill only fields the user hasn't already touched: the composer is
				// editable while drafts.get is in flight, so unconditional assignment
				// would clobber (and then autosave away) edits typed in the gap.
				if (toAddresses.value.length === 0) toAddresses.value = draft.toAddresses ?? [];
				if (ccAddresses.value.length === 0) ccAddresses.value = draft.ccAddresses ?? [];
				if (bccAddresses.value.length === 0) bccAddresses.value = draft.bccAddresses ?? [];
				if (!subject.value) subject.value = draft.subject ?? '';
				if (!bodyHtml.value) bodyHtml.value = draft.bodyHtml ?? '';
				if (!fromAddress.value && draft.fromAddress) fromAddress.value = draft.fromAddress;
				if (draft.composerMode) composerMode.value = draft.composerMode;
				if (bodyBlocks.value.length === 0 && draft.bodyBlocks) {
					try {
						bodyBlocks.value = JSON.parse(draft.bodyBlocks) as EditorBlock[];
					} catch {
						// Leave empty on malformed JSON.
					}
				}
				if (attachments.value.length === 0) {
					attachments.value = (draft.attachments ?? []).map((a) => ({
						storageId: a.storageId,
						filename: a.filename,
						contentType: a.contentType,
						size: a.size,
					}));
				}
			},
			{ immediate: true }
		);
	}

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
		if (result === undefined) return;
		fromAddress.value = address.trim().toLowerCase();
	}

	// Signatures for this mailbox. The default is auto-prepended to a fresh
	// draft; the composer toolbar lets the user pick a different one per
	// message (applySignature swaps the marked block in-body).
	interface ComposerSignature {
		_id: Id<'mailSignatures'>;
		name: string;
		html: string;
		isDefault: boolean;
	}
	const signaturesQuery = useConvexQuery(api.mail.signatures.list, () => ({
		mailboxId: seed.mailboxId,
	}));
	const signatures = computed<ComposerSignature[]>(
		() => (signaturesQuery.data.value as ComposerSignature[] | undefined) ?? []
	);
	// Which signature is currently sitting in the body. `null` once the user has
	// chosen "No signature" (or before anything is applied).
	const activeSignatureId = ref<Id<'mailSignatures'> | null>(null);

	/** Swap the in-body signature block to the chosen signature (or none). */
	function applySignature(signatureId: Id<'mailSignatures'> | null) {
		const sig = signatureId ? signatures.value.find((s) => s._id === signatureId) : null;
		bodyHtml.value = applySignatureToBody(bodyHtml.value, sig?.html ?? '');
		activeSignatureId.value = sig?._id ?? null;
	}

	// Auto-prepend the default signature to a fresh, empty draft.
	// A reopened draft (seed.draftId) already carries its own signature in the
	// saved body; auto-prepending here would race drafts.get hydration — if this
	// watcher wins it writes the signature into the still-empty body, hydration's
	// `if (!bodyHtml.value)` guard then skips loading the saved body, and autosave
	// later persists the signature OVER the saved draft (silent data loss). So we
	// only auto-prepend for a brand-new compose, never when reopening a draft.
	let signaturePrepended = Boolean(seed.draftId);
	watch(
		() => signatures.value,
		(sigs) => {
			if (signaturePrepended) return;
			if (sigs.length === 0) return;
			signaturePrepended = true;
			const def = sigs.find((s) => s.isDefault);
			if (!def) return;
			// Only prepend if the body is still empty / unedited.
			if (bodyHtml.value.trim().length > 0) return;
			bodyHtml.value = `${wrapSignatureBlock(def.html)}`;
			activeSignatureId.value = def._id;
		},
		{ immediate: true }
	);

	async function ensureDraft(): Promise<Id<'mailDrafts'> | null> {
		if (draftId.value) return draftId.value;
		if (ensuring.value) return null;
		ensuring.value = true;
		try {
			const result = await createDraft.run({
				mailboxId: seed.mailboxId,
				inReplyToMessageId: seed.inReplyToMessageId,
			});
			if (!result) return null;
			draftId.value = result.draftId as Id<'mailDrafts'>;
			if (result.inReplySubject && !subject.value) {
				subject.value = result.inReplySubject.match(/^re\s*:\s*/i)
					? result.inReplySubject
					: `Re: ${result.inReplySubject}`;
			}
			if (result.inReplyFrom && toAddresses.value.length === 0) {
				toAddresses.value = [result.inReplyFrom];
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
			if (result === undefined) return;
			lastSavedAt.value = (result.savedAt as number) ?? Date.now();
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

	async function send(opts?: {
		undoSendDelayMs?: number;
		scheduledSendAt?: number;
		allowUnsealed?: boolean;
	}) {
		// Flush any pending autosave first
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
			pendingSave = persist();
		}
		if (pendingSave) await pendingSave;

		const id = await ensureDraft();
		if (!id) throw new Error('No draft');

		const result = await sendDraft.run({
			draftId: id,
			undoSendDelayMs: opts?.undoSendDelayMs,
			scheduledSendAt: opts?.scheduledSendAt,
			allowUnsealed: opts?.allowUnsealed,
		});
		// `useBackendOperation.run` swallows categorized failures (it has already
		// toasted them) and returns `undefined`. Surface that as a throw so the
		// caller never arms undo / navigates away on a failed send.
		if (result === undefined) {
			throw new Error('Send failed');
		}
		return result as { undoToken: string; sendAt: number };
	}

	async function discard() {
		if (saveTimer) clearTimeout(saveTimer);
		if (draftId.value) {
			const result = await discardDraft.run({ draftId: draftId.value });
			if (result === undefined) return;
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
		if (!result?.ok) return false;
		draftState.value = 'draft';
		scheduledSendAt.value = null;
		return true;
	}

	async function undoSend(undoToken: string) {
		const result = await cancelPending.run({ undoToken });
		if (result?.ok) {
			draftId.value = (result.draftId as Id<'mailDrafts'>) ?? draftId.value;
		}
		return result;
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
		cancelUpload,
		retryUpload,
		addInlineImage,
		removeInlineImage,
		isSaving,
		lastSavedAt,
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
