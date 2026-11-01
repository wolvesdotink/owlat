import { computed, ref, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * Chat integration on a Team Inbox thread: the chat channels that already
 * discuss it, and a new channel linked to it. Only active when the chat flag is
 * enabled — the query throws FEATURE_DISABLED otherwise.
 */
export function useTeamThreadDiscussionChannels(threadId: Ref<Id<'conversationThreads'>>) {
	const { t } = useI18n();
	const { showToast } = useToast();
	const { isEnabled: isFeatureEnabled } = useFeatureFlag();

	const chatEnabled = computed(() => isFeatureEnabled('chat'));

	const { data: discussionChannelsData } = useConvexQuery(
		api.chat.emailLink.findChannelsForInboxThread,
		() => (chatEnabled.value ? { inboxThreadId: threadId.value } : 'skip')
	);
	const discussionChannels = computed(() => discussionChannelsData.value ?? []);

	const showNewChannel = ref(false);
	const router = useRouter();
	const { linkChannelToInboxThread } = useChatActions();
	const onChannelCreated = async (roomId: Id<'chatRooms'>) => {
		// Channel was just created — link it to this inbox thread, then jump.
		// run() toasts its own failure and resolves `ok: false`; only navigate into
		// the channel when the link actually persisted.
		const result = await linkChannelToInboxThread(roomId, threadId.value);
		showNewChannel.value = false;
		if (!result.ok) {
			showToast(t('dashboard.inbox.detail.channelLinkFailedToast'), 'error');
			return;
		}
		router.push(`/dashboard/chat/${roomId}`);
	};

	return { chatEnabled, discussionChannels, showNewChannel, onChannelCreated };
}
