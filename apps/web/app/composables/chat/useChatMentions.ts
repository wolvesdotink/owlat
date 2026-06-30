import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * Unread @-mentions feed + count for the chat nav badge and an optional
 * "Mentions" inbox panel.
 */
export function useChatMentions(withList: () => boolean = () => false) {
	const { data: countData } = useConvexQuery(
		api.chat.mentions.countMyUnreadMentions,
		() => ({}),
	);
	// The nav badge only needs the count; the 50-row list is opened lazily by an
	// actual mentions panel (withList()), not by every dashboard render.
	const { data: mentionsData, isLoading: mentionsLoading } = useConvexQuery(
		api.chat.mentions.listMyUnreadMentions,
		() => (withList() ? { limit: 50 } : 'skip'),
	);

	const { run: markReadMutation } = useBackendOperation(
		api.chat.mentions.markMentionRead,
		{ label: 'Mark mention read' },
	);

	const count = computed(() => countData.value ?? 0);
	const mentions = computed(() => mentionsData.value ?? []);

	const markMentionRead = async (mentionId: Id<'chatMentions'>) => {
		await markReadMutation({ mentionId });
	};

	return { count, mentions, mentionsLoading, markMentionRead };
}

/**
 * Search for org members to mention in the @-picker. Returns an empty list
 * for an empty query (caller can decide whether to show a default list).
 *
 * `includeAssistant` (default true) surfaces the reserved @assistant pseudo-
 * member for the in-message mention picker. The human-member pickers (new
 * channel/DM, add member) pass `false`: @assistant is not a real org member, so
 * selecting it there fails server-side ("not a member of this organization").
 */
export function useChatMentionSearch(
	queryRef: () => string | null,
	options: { includeAssistant?: boolean } = {},
) {
	const includeAssistant = options.includeAssistant ?? true;
	const { isEnabled } = useFeatureFlag();
	const { data, isLoading } = useConvexQuery(
		api.chat.mentions.searchOrgMembersForMention,
		() => {
			// null → no active @-mention; skip rather than holding a live member
			// subscription. '' is a real search (the default member list).
			const q = queryRef();
			return q === null ? 'skip' : { query: q };
		},
	);
	const candidates = computed(() => {
		const base = data.value ?? [];
		const q = queryRef();
		// Surface the reserved @assistant as a mention target when the AI assistant
		// is enabled and the in-progress handle is a prefix of "assistant".
		if (includeAssistant && q !== null && isEnabled('ai.assistant')) {
			const ql = q.toLowerCase();
			if (ql === '' || 'assistant'.startsWith(ql)) {
				return [
					{ memberId: 'system:assistant', name: 'Assistant', email: null, image: null, handle: 'assistant' },
					...base,
				];
			}
		}
		return base;
	});
	return { candidates, isLoading };
}
