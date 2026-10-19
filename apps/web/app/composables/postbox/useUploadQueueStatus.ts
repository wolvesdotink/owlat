/**
 * What a composer's attachment row says to a screen reader about its upload
 * queue: how many files are waiting for a transfer slot, and that none are
 * once the last one has left the queue. A queued chip is only visible, so
 * without this someone whose focus is elsewhere never learns that files are
 * waiting.
 *
 * The text follows the queued COUNT alone, so byte progress never re-announces
 * it. It starts empty and stays empty for a composer that never queued
 * anything. The caller renders it in a polite live region that is always
 * mounted (a region mounted together with its first message is usually not
 * read).
 */
import type { UploadChip } from './postboxAttachmentUploads';

export function useUploadQueueStatus(uploads: () => readonly UploadChip[]) {
	const { t } = useI18n();
	const queued = computed(() => uploads().filter((c) => c.status === 'queued').length);
	const status = ref('');
	watch(queued, (count, before) => {
		if (count > 0) {
			status.value = t(
				'shared.postbox.usePostboxComposeAttachments.uploadQueued',
				{ count },
				count
			);
		} else if (before > 0) {
			status.value = t('shared.postbox.usePostboxComposeAttachments.uploadQueueEmpty');
		}
	});
	return status;
}
