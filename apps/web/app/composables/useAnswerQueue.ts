import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import type { Ref } from 'vue';
import type { InboxIdentity } from '~/utils/inboxIdentity';
import { compareAnswerItems } from '~/utils/answerQueue';
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
 * only merges what the viewer could already open.
 *
 * `hiddenMailboxIds` drops the reply-queue rows of those inboxes: Today passes
 * the inboxes the viewer left out of it, while the Answer queue itself and the
 * sidebar count keep every inbox.
 */
export function useAnswerQueue(
	options: { hiddenMailboxIds?: Ref<readonly Id<'mailboxes'>[]> } = {}
) {
	const { isEnabled } = useFeatureFlag();
	const { isAdmin } = usePermissions();
	const { ids, byId, isLoading: inboxesLoading } = useInboxes();

	const mailResults = useConvexQueryMap(api.mail.needsReply.listQueue, ids, (mailboxId) => ({
		mailboxId,
	}));

	const teamEnabled = computed(() => isAdmin.value && isEnabled('inbox'));
	const { data: reviewData, isLoading: reviewLoading } = useConvexQuery(
		api.inbox.queries.getReviewQueue,
		() => (teamEnabled.value ? { limit: 50 } : 'skip')
	);

	const chatEnabled = computed(() => isAdmin.value && isEnabled('chat'));
	const { data: mentionData, isLoading: mentionLoading } = useConvexQuery(
		api.chat.mentions.listMyUnreadMentions,
		() => (chatEnabled.value ? { limit: 25 } : 'skip')
	);

	const items = computed<AnswerItem[]>(() => {
		const out: AnswerItem[] = [];
		const hidden = new Set(options.hiddenMailboxIds?.value ?? []);
		for (const [mailboxId, result] of mailResults) {
			if (hidden.has(mailboxId)) continue;
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
		for (const result of mailResults.values()) if (result.isLoading.value) return true;
		return (
			(teamEnabled.value && reviewLoading.value) || (chatEnabled.value && mentionLoading.value)
		);
	});

	const counts = computed(() => {
		const tally = { mail: 0, team: 0, mention: 0, drafts: 0 };
		for (const item of items.value) {
			tally[item.source] += 1;
			if (item.source === 'team' && item.entry.message.draftResponse?.trim()) tally.drafts += 1;
			if (item.source === 'mail' && item.row.draftSlot) tally.drafts += 1;
		}
		return tally;
	});

	return {
		items,
		count: computed(() => items.value.length),
		counts,
		isLoading,
		teamEnabled,
		chatEnabled,
	};
}
