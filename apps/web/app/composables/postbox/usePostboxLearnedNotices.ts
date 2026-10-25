import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { watch, type Ref } from 'vue';
import { usePostboxArrivalUndo } from '~/composables/postbox/usePostboxArrivalUndo';

/**
 * The learned-digest notice: once Owlat learned from unread
 * archives that a sender belongs in the digest, the Postbox says so once,
 * "Mail from X now goes to your digest · Undo". The notice is acknowledged
 * when its toast leaves the screen, so it never comes back; Undo restores the
 * status and keeps it from being learned again.
 */
export function usePostboxLearnedNotices(mailboxId: Ref<Id<'mailboxes'>>): void {
	const { t } = useI18n();
	const { offerUndo } = usePostboxArrivalUndo();
	const acknowledge = useBackendOperation(api.mail.arrival.learning.acknowledge, {
		label: () => t('postbox.learned.operation'),
	});
	const { data } = useConvexQuery(api.mail.arrival.learning.notices, () => ({
		mailboxId: mailboxId.value,
	}));
	// One toast per notice per page load, even while the acknowledgement is in flight.
	const shown = new Set<string>();

	watch(
		data,
		(notices) => {
			for (const notice of notices ?? []) {
				if (shown.has(notice.operationId)) continue;
				shown.add(notice.operationId);
				const name = notice.displayName || notice.address;
				offerUndo(t('postbox.learned.notice', { name }), notice.operationId, {
					type: 'info',
					onDismiss: () => void acknowledge.run({ operationId: notice.operationId }),
				});
			}
		},
		{ immediate: true }
	);
}
