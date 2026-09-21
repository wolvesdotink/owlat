import { loadRawEml } from '~/composables/postbox/loadRawEml';
import { useMimePartDownload } from '~/composables/useMimePartDownload';
import { previewSliceFor } from '~/utils/postboxFileFacets';
import type { AttachmentMeta } from '~/utils/attachmentMeta';

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
		attachments: AttachmentMeta[];
		index: number;
	} | null>(null);

	function openAttachmentPreview(messageId: string, att: AttachmentMeta, all: AttachmentMeta[]) {
		// `previewSliceFor` is the file library's rule, and the only one: it
		// normalises `image/PNG; name=x` where the hand-rolled copies here did
		// not, so the same file gets an eye in every view or in none.
		const slice = previewSliceFor(all, att);
		if (!slice) return;
		lightbox.value = { messageId, attachments: slice.attachments, index: slice.index };
	}

	function loadLightboxPart(att: AttachmentMeta): Promise<Blob | null> {
		const lb = lightbox.value;
		return lb ? extractPartBlob(lb.messageId, att) : Promise.resolve(null);
	}

	function downloadLightboxAttachment(att: AttachmentMeta) {
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
