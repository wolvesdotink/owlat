/**
 * Attachment machinery for the compose draft: upload/remove, a generated file
 * the open hands over (e.g. an iCalendar RSVP reply) and forward-cloning the
 * original message's attachments; the last two are expected attachments that
 * survive a reload until they are on the row (usePostboxComposeExpected). Split
 * out of usePostboxCompose so each file stays a readable size; it operates on
 * the same draft via the parent's ensureDraft/draftId.
 */

import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { ATTACHMENT_COMPOSE_LIMITS, MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { extractAttachments } from '@owlat/shared/mailMime';
import { downscaleImageFile } from './postboxInlineImage';
import { attachmentMeter } from './postboxAttachmentMeter';
import { createAttachmentUploads, xhrPutFile } from './postboxAttachmentUploads';
import type { InitialHydrationState } from './usePostboxComposeHydration';
import { usePostboxComposeExpected } from './usePostboxComposeExpected';
import type { ExpectedSource, GeneratedAttachment } from './usePostboxExpectedAttachments';
import { appendShareLinkBlock, shareLinkBlockHtml } from '~/utils/postboxShareLink';

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
	/**
	 * The draft body. "Share as link instead" edits it: the attachment leaves the
	 * message and a link block takes its place, so the two halves of the swap
	 * have to happen against the same ref the parent autosaves.
	 */
	bodyHtml?: Ref<string>;
	/**
	 * True while a reopened draft's body has not loaded. The share swap appends
	 * its link block to the body, which is still empty then, so the swap would
	 * leave a link-only body that replaces the saved one.
	 */
	bodyLocked?: () => boolean;
	/** Attach a file the app generated (e.g. an iCalendar RSVP reply). */
	attachGenerated?: GeneratedAttachment;
	/** Forward: clone the original message's attachments onto this draft. */
	forwardAttachmentsFromMessageId?: Id<'mailMessages'>;
	/** Hear about the row once it exists (the expected attachments are recorded on it). */
	onCreated?: (listener: (id: Id<'mailDrafts'>) => void) => () => void;
	/** Whether a reopened row has loaded (its attachments are known then). */
	rowState?: () => InitialHydrationState;
}) {
	const { t, locale } = useI18n();
	const generateUploadUrl = useBackendOperation(api.storage.generateUploadUrl, {
		label: () => t('shared.postbox.usePostboxComposeAttachments.prepareUploadOperation'),
	});
	const addAttachmentOp = useBackendOperation(api.mail.drafts.addAttachment, {
		label: () => t('shared.postbox.usePostboxComposeAttachments.attachOperation'),
	});
	// Attaching an upload again after a reload: refused when it cannot be taken,
	// which only means it is uploaded once more, so nothing is surfaced.
	const reattachOp = useBackendOperation(api.mail.drafts.addAttachment, {
		label: () => t('shared.postbox.usePostboxComposeAttachments.attachOperation'),
		onError: () => true,
		announce: false,
	});
	const removeAttachmentOp = useBackendOperation(api.mail.drafts.removeAttachment, {
		label: () => t('shared.postbox.usePostboxComposeAttachments.removeOperation'),
	});

	/** Megabyte ceilings read out in the active locale's number format. */
	const formatMb = (mb: number) => new Intl.NumberFormat(locale.value).format(mb);

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
		generateUploadUrl: async () => {
			const minted = await generateUploadUrl.run({});
			return minted.ok ? minted.result : null;
		},
		putFile: xhrPutFile,
		attach: async (a, chipId) => {
			const draftIdVal = opts.draftId.value;
			if (!draftIdVal) return false;
			// An expected file is recorded before its attach is sent.
			if (!expected.beforeAttach(chipId, a.storageId)) return false;
			// addAttachment returns its own `{ ok }`; a failed operation is the
			// envelope's `ok: false` and never reaches it.
			const result = await addAttachmentOp.run({
				draftId: draftIdVal,
				storageId: a.storageId as Id<'_storage'>,
				filename: a.filename,
				contentType: a.contentType,
				size: a.size,
			});
			return result.ok && result.result.ok;
		},
		onCommitted: (a, thumbUrl, chipId) => {
			if (thumbUrl) thumbUrls.set(a.storageId, thumbUrl);
			attachments.value = [...attachments.value, a];
			expected.committed(chipId);
		},
		onDismissed: (chipId) => expected.dismissed(chipId),
	});

	const expectedSources: ExpectedSource[] = [
		...(opts.attachGenerated
			? [{ kind: 'generated' as const, attachment: opts.attachGenerated }]
			: []),
		...(opts.forwardAttachmentsFromMessageId
			? [{ kind: 'forward' as const, messageId: opts.forwardAttachmentsFromMessageId }]
			: []),
	];
	const expected = usePostboxComposeExpected({
		draftId: opts.draftId,
		sources: expectedSources,
		ensureDraft: opts.ensureDraft,
		onCreated: opts.onCreated,
		rowState: opts.rowState ?? (() => 'ready'),
		attachments,
		admit,
		upload: (files) => uploader.addFiles(files),
		reattach: async (a) => {
			const draftIdVal = opts.draftId.value;
			if (!draftIdVal) return false;
			const result = await reattachOp.run({
				draftId: draftIdVal,
				storageId: a.storageId as Id<'_storage'>,
				filename: a.filename,
				contentType: a.contentType,
				size: a.size,
			});
			return result.ok && result.result.ok;
		},
		loadForward: loadForwardedFiles,
	});

	// Send waits for uploads in flight, and for expected files not yet on the row.
	const isUploading = computed(
		() => uploader.isUploading.value || uploadingCount.value > 0 || expected.pending.value
	);

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
	 * counting committed + in-flight attachments so a user can't queue ten oversized
	 * files and OOM the send.
	 */
	async function addFiles(files: File[] | FileList) {
		const id = await opts.ensureDraft();
		if (!id) return;
		const accepted = admit(Array.from(files));
		if (accepted.length > 0) uploader.addFiles(accepted);
	}

	/** The files that pass the per-message limits, in order; each refusal is toasted. */
	function admit(files: File[]): File[] {
		// Existing footprint: committed attachments + still-uploading chips.
		let currentCount = attachments.value.length + uploader.uploads.value.length;
		let currentBytes =
			attachments.value.reduce((sum, a) => sum + a.size, 0) +
			uploader.uploads.value.reduce((sum, c) => sum + c.size, 0);
		const accepted: File[] = [];
		for (const file of files) {
			if (file.size > MAX_ATTACHMENT_BYTES) {
				showToast(
					t('shared.postbox.usePostboxComposeAttachments.tooLarge', {
						filename: file.name,
						max: formatMb(MAX_ATTACHMENT_MB),
					}),
					'error'
				);
				continue;
			}
			if (currentCount >= ATTACHMENT_COMPOSE_LIMITS.maxCount) {
				showToast(
					t('shared.postbox.usePostboxComposeAttachments.tooManyFiles', {
						count: ATTACHMENT_COMPOSE_LIMITS.maxCount,
					}),
					'error'
				);
				break;
			}
			if (currentBytes + file.size > ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes) {
				showToast(
					t('shared.postbox.usePostboxComposeAttachments.totalTooLarge', {
						max: formatMb(MAX_TOTAL_MB),
					}),
					'error'
				);
				break;
			}
			accepted.push(file);
			currentCount += 1;
			currentBytes += file.size;
		}
		return accepted;
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
		file: File
	): Promise<{ contentId: string; previewUrl: string } | null> {
		if (!file.type.startsWith('image/')) return null;
		const id = await opts.ensureDraft();
		if (!id) return null;

		const scaled = await downscaleImageFile(file);
		if (scaled.size > MAX_ATTACHMENT_BYTES) {
			showToast(
				t('shared.postbox.usePostboxComposeAttachments.tooLarge', {
					filename: file.name,
					max: formatMb(MAX_ATTACHMENT_MB),
				}),
				'error'
			);
			return null;
		}

		uploadingCount.value += 1;
		try {
			const url = await generateUploadUrl.run({});
			if (!url.ok) return null;
			const contentType = scaled.type || 'image/jpeg';
			const res = await fetch(url.result, {
				method: 'POST',
				headers: { 'Content-Type': contentType },
				body: scaled,
			});
			if (!res.ok) {
				showToast(
					t('shared.postbox.usePostboxComposeAttachments.uploadFailed', { filename: file.name }),
					'error'
				);
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
			if (!result.ok || !result.result.ok) return null;
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

	// ── Share as link instead (idea 10) ──────────────────────────────────────
	const shareAttachmentOp = useBackendOperation(
		api.mail.attachmentSharesActions.shareDraftAttachment,
		{ label: () => t('shared.postbox.usePostboxComposeAttachments.shareOperation') }
	);

	/**
	 * Swap one committed attachment for an expiring link in the body.
	 *
	 * The server owns the swap — it detaches the part and creates the share in
	 * one transaction after the malware scan — so this only mirrors the result
	 * locally: drop the chip, append the block. If the scan refuses the file,
	 * the chip stays exactly where it was and the user is told why, because the
	 * alternative (a silently vanished attachment) is far worse than a bounce.
	 */
	async function shareAsLink(storageId: string): Promise<boolean> {
		const id = opts.draftId.value;
		if (!id || opts.bodyLocked?.()) return false;
		const attachment = attachments.value.find((a) => a.storageId === storageId);
		if (!attachment) return false;

		const outcome = await shareAttachmentOp.run({
			draftId: id,
			storageId: storageId as Id<'_storage'>,
		});
		if (!outcome.ok) return false;
		const share = outcome.result;
		if (!share.ok) {
			// Two different refusals, two different sentences: the scanner found
			// malware, or the file-type gate will not pass this type through.
			// Telling someone their spreadsheet is infected because a policy
			// refused its type is the kind of false alarm that stops being read.
			const key =
				share.reason === 'refused'
					? 'shared.postbox.usePostboxComposeAttachments.shareRefused'
					: 'shared.postbox.usePostboxComposeAttachments.shareInfected';
			showToast(t(key, { filename: share.filename }), 'error');
			return false;
		}

		if (opts.bodyHtml) {
			opts.bodyHtml.value = appendShareLinkBlock(
				opts.bodyHtml.value,
				shareLinkBlockHtml({
					url: share.url,
					filename: share.filename,
					heading: t('shared.postbox.usePostboxComposeAttachments.shareBlockHeading'),
					meta: t('shared.postbox.usePostboxComposeAttachments.shareBlockMeta', {
						size: formatCompactFileSize(share.size),
						date: formatDate(share.expiresAt, 'medium', locale.value),
					}),
				})
			);
		}

		attachments.value = attachments.value.filter((a) => a.storageId !== storageId);
		const thumb = thumbUrls.get(storageId);
		if (thumb) {
			URL.revokeObjectURL(thumb);
			thumbUrls.delete(storageId);
		}
		showToast(
			t('shared.postbox.usePostboxComposeAttachments.shareDone', { filename: share.filename }),
			'success'
		);
		return true;
	}

	async function removeAttachment(storageId: string) {
		const id = opts.draftId.value;
		if (!id) return;
		const result = await removeAttachmentOp.run({
			draftId: id,
			storageId: storageId as Id<'_storage'>,
		});
		if (!result.ok || !result.result?.ok) return;
		attachments.value = attachments.value.filter((a) => a.storageId !== storageId);
		const thumb = thumbUrls.get(storageId);
		if (thumb) {
			URL.revokeObjectURL(thumb);
			thumbUrls.delete(storageId);
		}
	}

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
		shareAsLink,
		isSharing: shareAttachmentOp.isLoading,
		cancelUpload: uploader.cancel,
		retryUpload: uploader.retry,
		addInlineImage,
		removeInlineImage,
	};
}

/**
 * Forward: the original message's attachments, read from its raw .eml and
 * extracted client-side (they go through the normal upload path). Null when
 * the message cannot be read; the forward still works without them.
 */
async function loadForwardedFiles(messageId: Id<'mailMessages'>): Promise<File[] | null> {
	try {
		const bin = await loadRawEml(messageId);
		if (!bin) return null;
		return extractAttachments(bin)
			.filter((a) => a.disposition === 'attachment')
			.map((a) => new File([a.bytes as BlobPart], a.filename, { type: a.contentType }));
	} catch {
		return null;
	}
}
