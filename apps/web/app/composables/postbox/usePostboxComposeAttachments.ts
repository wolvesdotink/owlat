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
import { ATTACHMENT_COMPOSE_LIMITS, MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { extractAttachments } from '@owlat/shared/mailMime';
import { downscaleImageFile } from './postboxInlineImage';
import { attachmentMeter } from './postboxAttachmentMeter';
import { createAttachmentUploads, xhrPutFile } from './postboxAttachmentUploads';

// Per-file attachment ceiling for user-facing copy, derived from the shared cap
// (mirrors MAX_LIBRARY_FILE_MB) so the label moves with MAX_ATTACHMENT_BYTES.
const MAX_ATTACHMENT_MB = MAX_ATTACHMENT_BYTES / 1024 / 1024;

// Per-message combined-size ceiling for user-facing copy, derived from the shared
// compose limit so the label moves with ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes.
const MAX_TOTAL_MB = ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes / 1024 / 1024;

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
	// Inline-image uploads still use their own path; count them so `isUploading`
	// covers both surfaces. File attachments track their own per-chip state below.
	const uploadingCount = ref(0);

	const { showToast } = useToast();

	// Object URLs for committed image attachments, keyed by storageId, so the
	// chip can show a thumbnail without a second fetch. Revoked on removal/unmount.
	const thumbUrls = new Map<string, string>();

	// Per-file upload chips (progress / cancel / retry / thumbnail). Committed
	// uploads graduate into `attachments` via onCommitted; the transport (Convex
	// upload URL + XHR + addAttachment) is injected so the state machine stays
	// testable and this composable owns only the wiring.
	const uploader = createAttachmentUploads({
		generateUploadUrl: async () => (await generateUploadUrl.run({})) ?? null,
		putFile: xhrPutFile,
		attach: async (a) => {
			const draftIdVal = opts.draftId.value;
			if (!draftIdVal) return false;
			// addAttachment returns { ok } — run() yields undefined on failure.
			const result = await addAttachmentOp.run({
				draftId: draftIdVal,
				storageId: a.storageId as Id<'_storage'>,
				filename: a.filename,
				contentType: a.contentType,
				size: a.size,
			});
			return !!result?.ok;
		},
		onCommitted: (a, thumbUrl) => {
			if (thumbUrl) thumbUrls.set(a.storageId, thumbUrl);
			attachments.value = [...attachments.value, a];
		},
	});

	const isUploading = computed(() => uploader.isUploading.value || uploadingCount.value > 0);

	// Total-size meter across committed + in-flight attachments.
	const attachmentSizeMeter = computed(() => {
		const committed = attachments.value.reduce((sum, a) => sum + a.size, 0);
		const inflight = uploader.uploads.value.reduce((sum, c) => sum + c.size, 0);
		return attachmentMeter(committed + inflight);
	});

	/** Object URL for a committed image attachment's thumbnail, or null. */
	function thumbUrlFor(storageId: string): string | null {
		return thumbUrls.get(storageId) ?? null;
	}

	/**
	 * Reject files that would breach a per-message limit up front, then upload the
	 * rest as tracked chips. Three gates, mirroring the server-side enforcement so
	 * the interactive path can never queue more than the send path accepts:
	 *   - per-file byte cap (MAX_ATTACHMENT_BYTES),
	 *   - attachment COUNT cap (ATTACHMENT_COMPOSE_LIMITS.maxCount),
	 *   - combined-SIZE cap (ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes),
	 * counting committed + in-flight attachments so a user can't queue 10×25 MB and
	 * OOM the send.
	 */
	async function addFiles(files: File[] | FileList) {
		const id = await opts.ensureDraft();
		if (!id) return;
		// Existing footprint: committed attachments + still-uploading chips.
		let currentCount = attachments.value.length + uploader.uploads.value.length;
		let currentBytes =
			attachments.value.reduce((sum, a) => sum + a.size, 0) +
			uploader.uploads.value.reduce((sum, c) => sum + c.size, 0);
		const accepted: File[] = [];
		for (const file of Array.from(files)) {
			if (file.size > MAX_ATTACHMENT_BYTES) {
				showToast(`${file.name} is too large (max ${MAX_ATTACHMENT_MB} MB).`, 'error');
				continue;
			}
			if (currentCount >= ATTACHMENT_COMPOSE_LIMITS.maxCount) {
				showToast(
					`You can attach up to ${ATTACHMENT_COMPOSE_LIMITS.maxCount} files.`,
					'error',
				);
				break;
			}
			if (currentBytes + file.size > ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes) {
				showToast(`Attachments exceed the ${MAX_TOTAL_MB} MB total limit.`, 'error');
				break;
			}
			accepted.push(file);
			currentCount += 1;
			currentBytes += file.size;
		}
		if (accepted.length > 0) uploader.addFiles(accepted);
	}

	// Inline body images: their bytes live in the SAME draft attachment store as
	// files (uploaded via generateUploadUrl + addAttachment) but flagged
	// `isInline` with a Content-ID, and they are NOT surfaced in the attachment
	// row (they render in the body). Tracked here by contentId so the editor can
	// drop the pending part when the user deletes the image from the body.
	const inlineParts = ref<Array<{ contentId: string; storageId: string }>>([]);

	function newContentId(): string {
		const rand =
			typeof crypto !== 'undefined' && 'randomUUID' in crypto
				? crypto.randomUUID().replace(/-/g, '')
				: Math.random().toString(36).slice(2) + Date.now().toString(36);
		return `${rand}@owlat.inline`;
	}

	/**
	 * Downscale, upload and attach an image as an INLINE part, returning the
	 * `contentId` + an ephemeral preview object-URL the editor inserts as the
	 * `<img>` src (rewritten to `cid:` at send time). Returns null on any failure
	 * so the editor simply inserts nothing rather than breaking the compose flow.
	 */
	async function addInlineImage(
		file: File,
	): Promise<{ contentId: string; previewUrl: string } | null> {
		if (!file.type.startsWith('image/')) return null;
		const id = await opts.ensureDraft();
		if (!id) return null;

		const scaled = await downscaleImageFile(file);
		if (scaled.size > MAX_ATTACHMENT_BYTES) {
			showToast(`${file.name} is too large (max ${MAX_ATTACHMENT_MB} MB).`, 'error');
			return null;
		}

		uploadingCount.value += 1;
		try {
			const url = await generateUploadUrl.run({});
			if (!url) return null;
			const contentType = scaled.type || 'image/jpeg';
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': contentType },
				body: scaled,
			});
			if (!res.ok) {
				showToast(`Couldn't upload ${file.name}.`, 'error');
				return null;
			}
			const { storageId } = (await res.json()) as { storageId: string };
			const contentId = newContentId();
			const result = await addAttachmentOp.run({
				draftId: id,
				storageId: storageId as Id<'_storage'>,
				filename: scaled.name,
				contentType,
				size: scaled.size,
				isInline: true,
				contentId,
			});
			if (!result?.ok) return null;
			inlineParts.value = [...inlineParts.value, { contentId, storageId }];
			return { contentId, previewUrl: URL.createObjectURL(scaled) };
		} finally {
			uploadingCount.value -= 1;
		}
	}

	/** Drop a pending inline part when its image is deleted from the body. */
	async function removeInlineImage(contentId: string) {
		const part = inlineParts.value.find((p) => p.contentId === contentId);
		if (!part) return;
		const id = opts.draftId.value;
		inlineParts.value = inlineParts.value.filter((p) => p.contentId !== contentId);
		if (!id) return;
		await removeAttachmentOp.run({
			draftId: id,
			storageId: part.storageId as Id<'_storage'>,
		});
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
		const thumb = thumbUrls.get(storageId);
		if (thumb) {
			URL.revokeObjectURL(thumb);
			thumbUrls.delete(storageId);
		}
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

	// Release outstanding object URLs when the composer is torn down.
	onUnmounted(() => {
		uploader.dispose();
		for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
		thumbUrls.clear();
	});

	return {
		attachments,
		uploads: uploader.uploads,
		isUploading,
		attachmentSizeMeter,
		thumbUrlFor,
		addFiles,
		removeAttachment,
		cancelUpload: uploader.cancel,
		retryUpload: uploader.retry,
		addInlineImage,
		removeInlineImage,
	};
}
