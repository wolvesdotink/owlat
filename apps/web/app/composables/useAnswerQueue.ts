import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import type { InboxIdentity } from '~/utils/inboxIdentity';
import { ANSWER_MENTION_LIMIT, ANSWER_REVIEW_LIMIT, compareAnswerItems } from '~/utils/answerQueue';
import type { ReplyQueueItem } from '~/utils/postboxReplyQueue';

type ReviewEntry = FunctionReturnType<typeof api.inbox.queries.getReviewQueue>[number];
type MentionEntry = FunctionReturnType<typeof api.chat.mentions.listMyUnreadMentions>[number];

export type AnswerItem =
	| {
			id: string;
			source: 'mail';
			at: number;
			mailboxId: Id<'mailboxes'>;
			inbox: InboxIdentity<Id<'mailboxes'>> | null;
			row: ReplyQueueItem;
	  }
	| { id: string; source: 'team'; at: number; entry: ReviewEntry }
	| { id: string; source: 'mention'; at: number; mention: MentionEntry };

/**
 * Everything waiting on the viewer's answer, in one ranked list:
 * reply-queue rows from every inbox they read, the team inbox's agent drafts
 * (owners/admins with the team inbox on) and unread chat mentions (where chat
 * is available to them). Each source keeps its own permission check — this
 * only merges what the viewer could already open. A Workbench tab narrows the
 * list itself (`answerItemMatches`) and tallies its share with `answerCounts`.
 *
 * Only the pages that show the list (Answer, Today) call this; the shell's
 * badges need a number and use `useAnswerQueueCount`, which reads the same
 * sources as counts (plan 2.11).
 */
export function useAnswerQueue(opts: { enabled?: () => boolean } = {}) {
	const { isEnabled } = useFeatureFlag();
	const { isAdmin, isRoleLoading } = usePermissions();
	const { ids, byId, isLoading: inboxesLoading } = useInboxes();
	// A host that mounts on every Answer mode route (the queue's parent page)
	// reads nothing until the queue is actually in use.
	const reading = computed(() => opts.enabled?.() ?? true);
	const mailboxIds = computed(() => (reading.value ? ids.value : []));

	const mailResults = useConvexQueryMap(api.mail.needsReply.listQueue, mailboxIds, (mailboxId) => ({
		mailboxId,
	}));

	const teamEnabled = computed(() => reading.value && isAdmin.value && isEnabled('inbox'));
	const { data: reviewData, isLoading: reviewLoading } = useConvexQuery(
		api.inbox.queries.getReviewQueue,
		() => (teamEnabled.value ? { limit: ANSWER_REVIEW_LIMIT } : 'skip')
	);

	const chatEnabled = computed(() => reading.value && isAdmin.value && isEnabled('chat'));
	const { data: mentionData, isLoading: mentionLoading } = useConvexQuery(
		api.chat.mentions.listMyUnreadMentions,
		() => (chatEnabled.value ? { limit: ANSWER_MENTION_LIMIT } : 'skip')
	);

	const items = computed<AnswerItem[]>(() => {
		const out: AnswerItem[] = [];
		for (const [mailboxId, result] of mailResults) {
			for (const row of result.data.value?.items ?? []) {
				out.push({
					id: `mail:${row.threadId}`,
					source: 'mail',
					at: row.receivedAt,
					mailboxId,
					inbox: byId.value.get(mailboxId) ?? null,
					row: row as ReplyQueueItem,
				});
			}
		}
		if (teamEnabled.value) {
			for (const entry of reviewData.value ?? []) {
				out.push({
					id: `team:${entry.message._id}`,
					source: 'team',
					at: entry.message.receivedAt,
					entry,
				});
			}
		}
		if (chatEnabled.value) {
			for (const mention of mentionData.value ?? []) {
				out.push({
					id: `mention:${mention._id}`,
					source: 'mention',
					at: mention.createdAt,
					mention,
				});
			}
		}
		return out.sort((a, b) =>
			compareAnswerItems(
				{ source: a.source, at: a.at, row: a.source === 'mail' ? a.row : undefined },
				{ source: b.source, at: b.at, row: b.source === 'mail' ? b.row : undefined }
			)
		);
	});

	const isLoading = computed(() => {
		if (inboxesLoading.value) return true;
		// The team drafts and mentions are gated on the role: until it resolves,
		// the list is not whole. A queue that started on the mail rows alone took
		// a team draft in later only at its end, out of its rank.
		if (reading.value && isRoleLoading?.value) return true;
		for (const result of mailResults.values()) if (result.isLoading.value) return true;
		return (
			(teamEnabled.value && reviewLoading.value) || (chatEnabled.value && mentionLoading.value)
		);
	});

	const counts = computed(() => answerCounts(items.value));

	return {
		items,
		count: computed(() => items.value.length),
		counts,
		isLoading,
		teamEnabled,
		chatEnabled,
	};
}

/** How many items come from each source, and how many already have a draft. */
export function answerCounts(items: readonly AnswerItem[]) {
	const tally = { mail: 0, team: 0, mention: 0, drafts: 0 };
	for (const item of items) {
		tally[item.source] += 1;
		if (item.source === 'team' && item.entry.message.draftResponse?.trim()) tally.drafts += 1;
		if (item.source === 'mail' && item.row.hasDraftSlot) tally.drafts += 1;
	}
	return tally;
}
