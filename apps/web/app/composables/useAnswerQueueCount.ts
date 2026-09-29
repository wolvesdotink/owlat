import { api } from '@owlat/api';
import { ANSWER_MENTION_LIMIT, ANSWER_REVIEW_LIMIT } from '~/utils/answerQueue';

/**
 * How many things wait on the viewer's answer: the size of `useAnswerQueue`'s
 * list, read as counts (plan 2.11).
 *
 * The shell shows this number on every dashboard page (the sidebar's Answer
 * row, the phone's tab bar). Subscribing the full lists there shipped every
 * inbox's reply-queue cards, the team review queue with its joins and the
 * mention previews just to print a number. Each source here is a count query
 * that runs the list's own filters with the same limits and gates, so the
 * badge and the Answer page agree; the lists are only read where they render.
 */
export function useAnswerQueueCount() {
	const { isEnabled } = useFeatureFlag();
	const { isAdmin } = usePermissions();
	const { ids } = useInboxes();

	const mailCounts = useConvexQueryMap(api.mail.needsReply.countQueue, ids, (mailboxId) => ({
		mailboxId,
	}));

	const teamEnabled = computed(() => isAdmin.value && isEnabled('inbox'));
	const { data: teamCount } = useConvexQuery(api.inbox.queries.countReviewQueue, () =>
		teamEnabled.value ? { limit: ANSWER_REVIEW_LIMIT } : 'skip'
	);

	const chatEnabled = computed(() => isAdmin.value && isEnabled('chat'));
	const { data: mentionCount } = useConvexQuery(
		api.chat.mentions.countMyVisibleUnreadMentions,
		() => (chatEnabled.value ? { limit: ANSWER_MENTION_LIMIT } : 'skip')
	);

	const count = computed(() => {
		let total = 0;
		for (const result of mailCounts.values()) total += result.data.value ?? 0;
		if (teamEnabled.value) total += teamCount.value ?? 0;
		if (chatEnabled.value) total += mentionCount.value ?? 0;
		return total;
	});

	return { count };
}
