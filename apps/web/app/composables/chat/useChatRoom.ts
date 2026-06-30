import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { Ref } from 'vue';

/**
 * Data + actions for a single chat room (channel or DM).
 *
 * Auto-marks the room read on subscription tick.
 */
export function useChatRoom(roomId: Ref<Id<'chatRooms'> | undefined>) {
	const { data: room, isLoading: roomLoading } = useConvexQuery(
		api.chat.rooms.getRoom,
		() => (roomId.value ? { roomId: roomId.value } : 'skip'),
	);

	// Growable window over the live message subscription: starts at 100, grows by
	// 100 up to the backend cap so "Load earlier messages" can reach older history
	// (previously hard-capped at 100 with no way to load more). Resets per room.
	const { limit: messageLimit, loadMore: loadMoreMessages, atMax: atMaxMessages } = useGrowableLimit(
		roomId,
		{ page: 100, max: 500 },
	);
	const { data: messagesData, isLoading: messagesLoading } = useConvexQuery(
		api.chat.messages.listMessages,
		() => (roomId.value ? { roomId: roomId.value, limit: messageLimit.value } : 'skip'),
	);

	const { data: membersData, isLoading: membersLoading } = useConvexQuery(
		api.chat.members.listRoomMembers,
		() => (roomId.value ? { roomId: roomId.value } : 'skip'),
	);

	const { data: linkedThread } = useConvexQuery(
		api.chat.emailLink.getLinkedThreadView,
		() => (roomId.value ? { roomId: roomId.value } : 'skip'),
	);

	const messages = computed(() => messagesData.value?.messages ?? []);
	const hasMoreMessages = computed(() => messagesData.value?.hasMore ?? false);
	const members = computed(() => membersData.value ?? []);

	const { run: sendMessageMutation } = useBackendOperation(
		api.chat.messages.sendMessage,
		{ label: 'Send message' },
	);
	const { run: editMessageMutation } = useBackendOperation(
		api.chat.messages.editMessage,
		{ label: 'Edit message' },
	);
	const { run: deleteMessageMutation } = useBackendOperation(
		api.chat.messages.deleteMessage,
		{ label: 'Delete message' },
	);
	const { run: markReadMutation } = useBackendOperation(
		api.chat.messages.markRead,
		{ label: 'Mark room read' },
	);
	const { run: joinChannelMutation } = useBackendOperation(
		api.chat.members.joinChannel,
		{ label: 'Join channel' },
	);
	const { run: leaveRoomMutation } = useBackendOperation(
		api.chat.members.leaveRoom,
		{ label: 'Leave room' },
	);

	const sendMessage = async (
		text: string,
		attachmentIds?: Id<'mediaAssets'>[],
	) => {
		if (!roomId.value) return;
		await sendMessageMutation({
			roomId: roomId.value,
			text,
			attachmentIds,
		});
	};

	const editMessage = async (messageId: Id<'chatMessages'>, text: string) => {
		await editMessageMutation({ messageId, text });
	};

	const deleteMessage = async (messageId: Id<'chatMessages'>) => {
		await deleteMessageMutation({ messageId });
	};

	const markRead = async () => {
		if (!roomId.value) return;
		await markReadMutation({ roomId: roomId.value });
	};

	const joinChannel = async () => {
		if (!roomId.value) return;
		await joinChannelMutation({ roomId: roomId.value });
	};

	const leaveRoom = async () => {
		if (!roomId.value) return;
		await leaveRoomMutation({ roomId: roomId.value });
	};

	// Mark as read whenever new messages arrive AND the user is the active
	// viewer. We treat any subscription tick as a read event; the parent page
	// can throttle this by unmounting the composable when the tab is hidden.
	watch(
		[messages, room],
		() => {
			if (!room.value?.isMember) return;
			if (messages.value.length === 0) return;
			void markRead();
		},
		{ flush: 'post' },
	);

	return {
		room,
		roomLoading,
		messages,
		messagesLoading,
		hasMoreMessages,
		loadMoreMessages,
		atMaxMessages,
		members,
		membersLoading,
		linkedThread,
		sendMessage,
		editMessage,
		deleteMessage,
		markRead,
		joinChannel,
		leaveRoom,
	};
}
