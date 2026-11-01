/**
 * The team side of PostboxThreadReader. Team discussion (chat/mailDiscussion.ts):
 * the internal panel beside (xl) or below the conversation, and whom its
 * composer is NOT writing to. A shared mailbox reads as a team thread instead:
 * actions pinned, notes between the emails.
 */
import { computed, type ComputedRef, type Ref } from 'vue';
import { discussionCounterpartyLabel } from '~/utils/postboxThreadDiscussion';
import type { PostboxReaderMessage, PostboxReaderThread } from './postboxReaderMessage';
import { usePostboxTeamStream } from './usePostboxTeamStream';

export function usePostboxReaderTeam(source: {
	message: () => PostboxReaderMessage;
	readerThread: Ref<PostboxReaderThread | null | undefined>;
	messages: ComputedRef<PostboxReaderMessage[]>;
	latestMessage: ComputedRef<PostboxReaderMessage | undefined>;
	ownAddresses: Ref<Set<string>>;
	isShared: () => boolean;
	/** Run `run` behind the reply guard for the latest message. */
	guardLatestReply: (run: () => void) => void;
	/** Answer mode on `msg` with `text` as the reply; resolves true once its draft is saved. */
	replyWithBody: (msg: PostboxReaderMessage, text: string) => Promise<boolean>;
	/** The reader's own Reply, for a team reply with nothing typed. */
	reply: () => void;
}) {
	const discussionThreadId = computed(
		() => source.readerThread.value?._id ?? source.message().threadId
	);
	const { articleClass: discussionArticleClass } = usePostboxThreadDiscussionPanel(
		() => discussionThreadId.value
	);
	const discussionCounterparty = computed(() =>
		discussionCounterpartyLabel(source.messages.value, source.ownAddresses.value)
	);
	const team = usePostboxTeamStream({
		isShared: source.isShared,
		threadId: () => discussionThreadId.value,
		messages: () => source.messages.value,
		reply: (text, handed) =>
			text.trim() && source.latestMessage.value
				? source.guardLatestReply(() => {
						// The reader's copy goes only once the reply's draft row is saved.
						void source.replyWithBody(source.latestMessage.value!, text).then((saved) => {
							if (saved) handed?.();
						});
					})
				: source.reply(),
	});

	return { discussionThreadId, discussionArticleClass, discussionCounterparty, team };
}
