import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * The rail and banner need a count without the queue's card joins. Same args
 * as the sidebar Answer badge (`useAnswerQueueCount`), so the two share one
 * subscription.
 */
export function usePostboxReplyQueueCount(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { data, isLoading } = useConvexQuery(api.mail.needsReply.countQueue, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);
	return { count: computed(() => data.value ?? 0), isLoading };
}
