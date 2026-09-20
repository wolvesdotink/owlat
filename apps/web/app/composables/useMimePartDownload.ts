import { extractAttachmentAt } from '@owlat/shared/mailMime';
import type { AttachmentMeta } from '~/utils/attachmentMeta';

/**
 * Download one attachment out of a message's raw `.eml`, client-side.
 *
 * The bytes are never on the message row — both readers store metadata and
 * keep the content in the sealed raw MIME — so a download means: fetch the raw
 * message once (the loader caches it per message), extract the named part, and
 * hand the browser a Blob. That dance, its spinner key, its object-URL lifetime
 * and its failure toast were written twice, once per reader; this is the one
 * copy.
 *
 * `loadRaw` is the reader's own loader (`postbox/loadRawEml` or
 * `loadInboundRawEml`) and `failureKey` its own i18n line, because the two
 * surfaces name the same failure in their own namespaces.
 */
export function useMimePartDownload(options: {
	loadRaw: (messageId: string) => Promise<string | null>;
	failureKey: string;
}) {
	const { t } = useI18n();
	const { showOperationError } = useOperationErrorToast();
	const { showToast } = useToast();

	/** `messageId:partIndex` of the part being extracted, so its row can spin. */
	const downloadingAttachment = ref<string | null>(null);

	/** Fetch the raw `.eml` and extract one part client-side as a Blob. */
	async function extractPartBlob(messageId: string, att: AttachmentMeta): Promise<Blob | null> {
		const bin = await options.loadRaw(messageId);
		if (!bin) return null;
		const extracted = extractAttachmentAt(bin, att.partIndex ?? '0', att.filename);
		if (!extracted) return null;
		return new Blob([extracted.bytes as BlobPart], {
			type: extracted.contentType || att.contentType,
		});
	}

	/** Extract the part, then trigger a browser download. */
	async function handleAttachmentDownload(messageId: string, att: AttachmentMeta): Promise<void> {
		const key = `${messageId}:${att.partIndex ?? att.filename}`;
		downloadingAttachment.value = key;
		try {
			const blob = await extractPartBlob(messageId, att);
			// A null blob is a failure too: the raw message did not load (released
			// bytes, quarantined message, no proxy origin, lost key) or the part is
			// not where the metadata said it was. Both used to end as a spinner that
			// stopped and a file that never arrived.
			if (!blob) {
				showToast(t(options.failureKey), 'error');
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
			// gets the attachment-specific line. Either way the reader hears about
			// it — the row stays available to try again.
			showOperationError(err, options.failureKey);
		} finally {
			downloadingAttachment.value = null;
		}
	}

	return { downloadingAttachment, extractPartBlob, handleAttachmentDownload };
}
