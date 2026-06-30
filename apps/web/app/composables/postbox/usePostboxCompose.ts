/**
 * Compose draft state machine with debounced autosave.
 *
 * Lifecycle:
 *   - ensureDraft() creates a draft row server-side if missing
 *   - any field change triggers a 1.5s-debounced upsert via update()
 *   - send() flushes pending autosave first, then invokes mailDrafts.send
 *     (which schedules dispatch after undoSendDelayMs)
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { EditorBlock } from '@owlat/email-builder';
import { MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { extractAttachments } from '@owlat/shared/mailMime';
import { applySignatureToBody, wrapSignatureBlock } from './usePostboxSignatureBody';

const AUTOSAVE_DEBOUNCE_MS = 1500;
// Per-file attachment ceiling for user-facing copy, derived from the shared cap
// (mirrors MAX_LIBRARY_FILE_MB) so the label moves with MAX_ATTACHMENT_BYTES.
const MAX_ATTACHMENT_MB = MAX_ATTACHMENT_BYTES / 1024 / 1024;

export type ComposerMode = 'simple' | 'full';

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
	const bodyBlocks = ref<EditorBlock[]>([]);          // EditorBlock[] in 'full' mode
	const composerMode = ref<ComposerMode>(seed.initialMode ?? 'simple');
	const fromAddress = ref<string>('');
	// Lifecycle state of the saved row. A reopened draft can be 'scheduled'
	// (a future send the user wants to review). While scheduled, autosave is
	// suppressed — drafts.update rejects non-'draft' rows — and the editor is
	// gated behind an explicit unschedule (mirrors campaigns' Unschedule-to-Edit).
	const draftState = ref<'draft' | 'pending_send' | 'scheduled'>('draft');
	const scheduledSendAt = ref<number | null>(null);
	const isScheduled = computed(() => draftState.value === 'scheduled');

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
	const generateUploadUrl = useBackendOperation(api.storage.generateUploadUrl, {
		label: 'Prepare upload',
	});
	const addAttachmentOp = useBackendOperation(api.mail.drafts.addAttachment, {
		label: 'Attach file',
	});
	const removeAttachmentOp = useBackendOperation(api.mail.drafts.removeAttachment, {
		label: 'Remove attachment',
	});

	interface ComposerAttachment {
		storageId: string;
		filename: string;
		contentType: string;
		size: number;
	}
	const attachments = ref<ComposerAttachment[]>([]);
	const uploadingCount = ref(0);
	const isUploading = computed(() => uploadingCount.value > 0);

	const { showToast } = useToast();

	/** Upload each file to Convex storage, then attach it to the draft. */
	async function addFiles(files: File[] | FileList) {
		const id = await ensureDraft();
		if (!id) return;
		for (const file of Array.from(files)) {
			if (file.size > MAX_ATTACHMENT_BYTES) {
				showToast(`${file.name} is too large (max ${MAX_ATTACHMENT_MB} MB).`, 'error');
				continue;
			}
			uploadingCount.value += 1;
			try {
				const url = await generateUploadUrl.run({});
				if (!url) continue;
				const res = await fetch(url, {
					method: 'POST',
					headers: { 'Content-Type': file.type || 'application/octet-stream' },
					body: file,
				});
				if (!res.ok) {
					showToast(`Couldn't upload ${file.name}.`, 'error');
					continue;
				}
				const { storageId } = (await res.json()) as { storageId: string };
				const contentType = file.type || 'application/octet-stream';
				// addAttachment now returns { ok } — useBackendOperation.run yields
				// undefined on failure, so gate on the truthy result, not !== undefined
				// (a void mutation would also be undefined on success).
				const result = await addAttachmentOp.run({
					draftId: id,
					storageId: storageId as Id<'_storage'>,
					filename: file.name,
					contentType,
					size: file.size,
				});
				if (!result?.ok) continue;
				attachments.value = [
					...attachments.value,
					{ storageId, filename: file.name, contentType, size: file.size },
				];
			} finally {
				uploadingCount.value -= 1;
			}
		}
	}

	async function removeAttachment(storageId: string) {
		const id = draftId.value;
		if (!id) return;
		const result = await removeAttachmentOp.run({
			draftId: id,
			storageId: storageId as Id<'_storage'>,
		});
		if (!result?.ok) return;
		attachments.value = attachments.value.filter((a) => a.storageId !== storageId);
	}

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
					attachments?: Array<{
						storageId: string;
						filename: string;
						contentType: string;
						size: number;
					}>;
				};
				draftState.value = draft.state ?? 'draft';
				scheduledSendAt.value = draft.scheduledSendAt ?? null;
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

	// Attach a transient generated file (e.g. an iCalendar RSVP REPLY) handed off
	// via usePostboxPendingAttachments.
	const { take: takePendingAttachment } = usePostboxPendingAttachments();
	onMounted(async () => {
		if (!seed.attachPendingKey) return;
		const pending = takePendingAttachment(seed.attachPendingKey);
		if (!pending) return;
		const file = new File([pending.content], pending.filename, { type: pending.contentType });
		await addFiles([file]);
	});

	// Forward: clone the original message's attachments onto this draft by
	// fetching its raw .eml, extracting the parts client-side, and re-uploading
	// them through the normal attachment path.
	onMounted(async () => {
		if (!seed.forwardAttachmentsFromMessageId) return;
		try {
			const bin = await loadRawEml(seed.forwardAttachmentsFromMessageId);
			if (!bin) return;
			const files = extractAttachments(bin)
				.filter((a) => a.disposition === 'attachment')
				.map((a) => new File([a.bytes as BlobPart], a.filename, { type: a.contentType }));
			if (files.length > 0) await addFiles(files);
		} catch {
			// Forward still works without the attachments.
		}
	});

	// Allowed-from set for this mailbox: canonical address + active aliases.
	// The server is the source of truth — the dropdown is just UI.
	const identitiesQuery = useConvexQuery(api.mail.identities.listForOwnedMailbox, () => ({
		mailboxId: seed.mailboxId,
	}));
	const availableIdentities = computed<string[]>(
		() => (identitiesQuery.data.value as string[] | undefined) ?? []
	);

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
		const sig = signatureId
			? signatures.value.find((s) => s._id === signatureId)
			: null;
		bodyHtml.value = applySignatureToBody(bodyHtml.value, sig?.html ?? '');
		activeSignatureId.value = sig?._id ?? null;
	}

	// Auto-prepend the default signature to a fresh, empty draft.
	let signaturePrepended = false;
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
				bodyBlocks:
					composerMode.value === 'full'
						? JSON.stringify(bodyBlocks.value)
						: undefined,
				composerMode: composerMode.value,
			});
			if (result === undefined) return;
			lastSavedAt.value = (result.savedAt as number) ?? Date.now();
		} finally {
			isSaving.value = false;
		}
	}

	// Watch for any field change
	watch(
		[toAddresses, ccAddresses, bccAddresses, subject, bodyHtml, bodyBlocks, composerMode],
		() => {
			schedulePersist();
		},
		{ deep: true }
	);

	const canSend = computed(() => {
		if (toAddresses.value.length === 0) return false;
		if (subject.value.trim().length > 0) return true;
		if (attachments.value.length > 0) return true;
		if (composerMode.value === 'full') return bodyBlocks.value.length > 0;
		// Strip HTML tags before measuring length so an empty <p></p>
		// from the contenteditable doesn't count as content.
		const plain = bodyHtml.value.replace(/<[^>]+>/g, '').trim();
		return plain.length > 0;
	});

	async function send(opts?: { undoSendDelayMs?: number; scheduledSendAt?: number }) {
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
		isUploading,
		addFiles,
		removeAttachment,
		isSaving,
		lastSavedAt,
		canSend,
		isScheduled,
		scheduledSendAt,
		cancelSchedule,
		ensureDraft,
		send,
		discard,
		undoSend,
	};
}
