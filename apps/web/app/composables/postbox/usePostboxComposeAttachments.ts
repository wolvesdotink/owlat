/**
 * Attachment machinery for the compose draft: upload/remove, the transient
 * pending-attachment handoff (e.g. iCalendar RSVP replies) and forward-cloning
 * the original message's attachments. Split out of usePostboxCompose so each
 * file stays a readable size; it operates on the same draft via the parent's
 * ensureDraft/draftId.
 */

import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { extractAttachments } from '@owlat/shared/mailMime';

// Per-file attachment ceiling for user-facing copy, derived from the shared cap
// (mirrors MAX_LIBRARY_FILE_MB) so the label moves with MAX_ATTACHMENT_BYTES.
const MAX_ATTACHMENT_MB = MAX_ATTACHMENT_BYTES / 1024 / 1024;

export interface ComposerAttachment {
	storageId: string;
	filename: string;
	contentType: string;
	size: number;
}

export function usePostboxComposeAttachments(opts: {
	ensureDraft: () => Promise<Id<'mailDrafts'> | null>;
	draftId: Ref<Id<'mailDrafts'> | null>;
	/** Attach a transient generated file handed off via usePostboxPendingAttachments. */
	attachPendingKey?: string;
	/** Forward: clone the original message's attachments onto this draft. */
	forwardAttachmentsFromMessageId?: Id<'mailMessages'>;
}) {
	const generateUploadUrl = useBackendOperation(api.storage.generateUploadUrl, {
		label: 'Prepare upload',
	});
	const addAttachmentOp = useBackendOperation(api.mail.drafts.addAttachment, {
		label: 'Attach file',
	});
	const removeAttachmentOp = useBackendOperation(api.mail.drafts.removeAttachment, {
		label: 'Remove attachment',
	});

	const attachments = ref<ComposerAttachment[]>([]);
	const uploadingCount = ref(0);
	const isUploading = computed(() => uploadingCount.value > 0);

	const { showToast } = useToast();

	/** Upload each file to Convex storage, then attach it to the draft. */
	async function addFiles(files: File[] | FileList) {
		const id = await opts.ensureDraft();
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
		const id = opts.draftId.value;
		if (!id) return;
		const result = await removeAttachmentOp.run({
			draftId: id,
			storageId: storageId as Id<'_storage'>,
		});
		if (!result?.ok) return;
		attachments.value = attachments.value.filter((a) => a.storageId !== storageId);
	}

	// Attach a transient generated file (e.g. an iCalendar RSVP REPLY) handed off
	// via usePostboxPendingAttachments.
	const { take: takePendingAttachment } = usePostboxPendingAttachments();
	onMounted(async () => {
		if (!opts.attachPendingKey) return;
		const pending = takePendingAttachment(opts.attachPendingKey);
		if (!pending) return;
		const file = new File([pending.content], pending.filename, { type: pending.contentType });
		await addFiles([file]);
	});

	// Forward: clone the original message's attachments onto this draft by
	// fetching its raw .eml, extracting the parts client-side, and re-uploading
	// them through the normal attachment path.
	onMounted(async () => {
		if (!opts.forwardAttachmentsFromMessageId) return;
		try {
			const bin = await loadRawEml(opts.forwardAttachmentsFromMessageId);
			if (!bin) return;
			const files = extractAttachments(bin)
				.filter((a) => a.disposition === 'attachment')
				.map((a) => new File([a.bytes as BlobPart], a.filename, { type: a.contentType }));
			if (files.length > 0) await addFiles(files);
		} catch {
			// Forward still works without the attachments.
		}
	});

	return {
		attachments,
		isUploading,
		addFiles,
		removeAttachment,
	};
}
