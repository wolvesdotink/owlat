import { loadRawEml } from '~/composables/postbox/loadRawEml';
import { useMimePartDownload } from '~/composables/useMimePartDownload';

/** One attachment row as the reader's message cards describe it. */
export type ReaderAttachmentMeta = {
	filename: string;
	contentType: string;
	size: number;
	partIndex?: string;
};

function isPreviewable(contentType: string): boolean {
	return contentType.startsWith('image/') || contentType === 'application/pdf';
}

/**
 * Attachment handling for the thread reader: the per-part download and the
 * Quick Look overlay for image/PDF parts.
 *
 * The download half — fetch the raw `.eml`, extract the part, hand the browser
 * a Blob, toast what failed — is `useMimePartDownload`, shared with the
 * team-inbox reader. What stays here is the lightbox, which only Postbox has.
 */
export function usePostboxReaderAttachments() {
	const { downloadingAttachment, extractPartBlob, handleAttachmentDownload } = useMimePartDownload({
		loadRaw: loadRawEml,
		failureKey: 'components.postbox.postboxThreadReader.attachmentDownloadFailed',
	});

	// Quick Look overlay state: the clicked message's PREVIEWABLE attachments in
	// display order plus the index of the one that was clicked. Null = closed.
	const lightbox = ref<{
		messageId: string;
		attachments: ReaderAttachmentMeta[];
		index: number;
	} | null>(null);

	function openAttachmentPreview(
		messageId: string,
		att: ReaderAttachmentMeta,
		all: ReaderAttachmentMeta[]
	) {
		const previewable = all.filter((a) => isPreviewable(a.contentType));
		const index = previewable.indexOf(att);
		if (index === -1) return;
		lightbox.value = { messageId, attachments: previewable, index };
	}

	function loadLightboxPart(att: ReaderAttachmentMeta): Promise<Blob | null> {
		const lb = lightbox.value;
		return lb ? extractPartBlob(lb.messageId, att) : Promise.resolve(null);
	}

	function downloadLightboxAttachment(att: ReaderAttachmentMeta) {
		const lb = lightbox.value;
		if (lb) void handleAttachmentDownload(lb.messageId, att);
	}

	return {
		downloadingAttachment,
		lightbox,
		handleAttachmentDownload,
		openAttachmentPreview,
		loadLightboxPart,
		downloadLightboxAttachment,
	};
}
