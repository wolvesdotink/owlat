/**
 * Download a message's ORIGINAL `.eml` — the bytes exactly as they arrived,
 * headers included.
 *
 * The details disclosure has offered this since UX plan idea 52; the reader's
 * per-message ⋯ menu offers it too (it is genuine overflow: rare, and the thing
 * you reach for when you want to read the raw headers yourself). One
 * implementation rather than two, so the two entry points can never disagree
 * about the filename, the decoding or the failure toast.
 *
 * The bytes come from the same signed-URL path the attachment extractor uses,
 * decoded latin1 (one char per byte). Fail-soft: a missing raw blob or a thrown
 * fetch both end in the same toast rather than a spinner that stops.
 */
export function usePostboxOriginalEml() {
	const { t } = useI18n();
	const { showToast } = useToast();

	const downloading = ref(false);

	async function downloadOriginal(messageId: string) {
		downloading.value = true;
		try {
			const raw = await loadRawEml(messageId);
			if (!raw) {
				showToast(t('components.postbox.postboxMessageDetails.downloadFailed'), 'error');
				return;
			}
			const bytes = new Uint8Array(raw.length);
			for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
			const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'message/rfc822' }));
			const a = document.createElement('a');
			a.href = url;
			a.download = 'message.eml';
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 30000);
		} catch {
			showToast(t('components.postbox.postboxMessageDetails.downloadFailed'), 'error');
		} finally {
			downloading.value = false;
		}
	}

	return { downloading, downloadOriginal };
}
