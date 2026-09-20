import { extractAttachmentAt } from '@owlat/shared/mailMime';
import { loadRawEml } from '~/composables/postbox/loadRawEml';

/** One attachment row as the reader's message cards describe it. */
export type ReaderAttachmentMeta = {
	filename: string;
	contentType: string;
	size: number;
	partIndex?: string;
};

type AttachmentPart = Pick<ReaderAttachmentMeta, 'filename' | 'contentType' | 'partIndex'>;

function isPreviewable(contentType: string): boolean {
	return contentType.startsWith('image/') || contentType === 'application/pdf';
}

/**
 * Attachment handling for the thread reader: the per-part download (the raw
 * .eml is fetched and the part extracted client-side) and the Quick Look
 * overlay for image/PDF parts. Extracted from PostboxThreadReader.vue;
 * behaviour is unchanged.
 */
export function usePostboxReaderAttachments() {
	const { t } = useI18n();
	const { showToast } = useToast();
	const { showOperationError } = useOperationErrorToast();

	/** `messageId:partIndex` of the part being extracted, so its row can spin. */
	const downloadingAttachment = ref<string | null>(null);

	/** Fetch the raw .eml and extract one part client-side as a Blob. */
	async function extractAttachmentBlob(
		messageId: string,
		att: AttachmentPart
	): Promise<Blob | null> {
		const bin = await loadRawEml(messageId);
		if (!bin) return null;
		const extracted = extractAttachmentAt(bin, att.partIndex ?? '0', att.filename);
		if (!extracted) return null;
		return new Blob([extracted.bytes as BlobPart], {
			type: extracted.contentType || att.contentType,
		});
	}

	/** Extract the part, then trigger a browser download. */
	async function handleAttachmentDownload(messageId: string, att: AttachmentPart) {
		const key = `${messageId}:${att.partIndex ?? att.filename}`;
		downloadingAttachment.value = key;
		try {
			const blob = await extractAttachmentBlob(messageId, att);
			// A null blob is a failure too: the raw message did not load, or the part
			// is not where the metadata said it was. Both used to end as a spinner
			// that stopped and a file that never arrived.
			if (!blob) {
				showToast(t('components.postbox.postboxThreadReader.attachmentDownloadFailed'), 'error');
				return;
			}
			const objectUrl = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = objectUrl;
			a.download = att.filename;
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
		} catch (err) {
			// A dropped connection reads as "Check your connection"; anything else
			// gets the attachment-specific line. Either way the reader hears about it
			// — the row stays available to try again.
			showOperationError(err, 'components.postbox.postboxThreadReader.attachmentDownloadFailed');
		} finally {
			downloadingAttachment.value = null;
		}
	}

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
		return lb ? extractAttachmentBlob(lb.messageId, att) : Promise.resolve(null);
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
