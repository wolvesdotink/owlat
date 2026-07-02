/**
 * Live Reply Queue subscription — the mailbox's "needs a reply from me"
 * threads, ranked urgency-then-age (see utils/postboxReplyQueue.ts).
 *
 * One shared Convex subscription serves the folder-rail badge, the inbox
 * strip and the queue page; replying / archiving / Done anywhere clears the
 * flag server-side, so every consumer drops the row live.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { compareReplyQueueItems, type ReplyQueueItem } from '~/utils/postboxReplyQueue';

export function usePostboxReplyQueue(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { data, isLoading } = useConvexQuery(api.mail.needsReply.listQueue, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);

	const items = computed<ReplyQueueItem[]>(() =>
		[...(data.value?.items ?? [])].sort(compareReplyQueueItems)
	);
	const count = computed(() => items.value.length);

	return { items, count, isLoading };
}
