/**
 * Uploading a file that answers a file question (Answer mode, plan §06).
 *
 * The same upload the composer's paperclip does (a one-shot upload URL, then
 * the bytes), minus the attach step: the answer names the fresh upload, and the
 * server attaches it to the draft (and keeps a copy in Files unless the person
 * opted out) when the answer is sent.
 */
import { api } from '@owlat/api';
import { MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { xhrPutFile } from '~/composables/postbox/postboxAttachmentUploads';

export interface AnswerUpload {
	storageId: string;
	filename: string;
	contentType: string;
	size: number;
}

export function useAnswerFileUpload() {
	const { t } = useI18n();
	const { showToast } = useToast();
	const generateUploadUrl = useBackendOperation(api.storage.generateUploadUrl, {
		label: () => t('shared.postbox.usePostboxComposeAttachments.prepareUploadOperation'),
		announce: false,
	});
	const uploading = ref(false);
	const progress = ref(0);

	async function upload(file: File): Promise<AnswerUpload | null> {
		if (file.size > MAX_ATTACHMENT_BYTES) {
			showToast(
				t('components.answer.fileAsk.tooLarge', {
					filename: file.name,
					mb: Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024),
				}),
				'error'
			);
			return null;
		}
		uploading.value = true;
		progress.value = 0;
		try {
			const minted = await generateUploadUrl.run({});
			if (!minted.ok) return null;
			const contentType = file.type || 'application/octet-stream';
			const storageId = await xhrPutFile(minted.result, file, contentType, {
				onProgress: (fraction) => (progress.value = fraction),
				signal: new AbortController().signal,
			});
			return { storageId, filename: file.name, contentType, size: file.size };
		} catch {
			showToast(t('components.answer.fileAsk.uploadFailed', { filename: file.name }), 'error');
			return null;
		} finally {
			uploading.value = false;
		}
	}

	return { upload, uploading, progress };
}
