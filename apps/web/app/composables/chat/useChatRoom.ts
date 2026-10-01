import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import type { Ref } from 'vue';
import type { BackendOperationResult } from '~/composables/useBackendOperation';

/**
 * One chat message as `listMessages` returns it: the stored row plus its
 * resolved `author` and the `isAssistant` flag. The message list and the
 * message row both take this, so neither can drift from the query.
 */
export type ChatMessageRow = FunctionReturnType<
	typeof api.chat.messages.listMessages
>['messages'][number];

/**
 * Data + actions for a single chat room (channel or DM).
 *
 * Marks the room read up to the newest message on screen while the tab is
 * visible (see the read acknowledgement below).
 */
export function useChatRoom(roomId: Ref<Id<'chatRooms'> | undefined>) {
	const { t } = useI18n();

	const {
		data: room,
		isLoading: roomLoading,
		error: roomError,
		refetch: refetchRoom,
	} = useConvexQuery(api.chat.rooms.getRoom, () =>
		roomId.value ? { roomId: roomId.value } : 'skip'
	);

	// Growable window over the live message subscription: starts at 100, grows by
	// 100 up to the backend cap so "Load earlier messages" can reach older history
	// (previously hard-capped at 100 with no way to load more). Resets per room.
	const {
		limit: messageLimit,
		loadMore: loadMoreMessages,
		atMax: atMaxMessages,
	} = useGrowableLimit(roomId, { page: 100, max: 500 });
	const {
		data: messagesData,
		isLoading: messagesLoading,
		error: messagesError,
		refetch: refetchMessages,
	} = useConvexQuery(
		api.chat.messages.listMessages,
		() => (roomId.value ? { roomId: roomId.value, limit: messageLimit.value } : 'skip'),
		// Each "Load earlier messages" closes the window it grew out of, so only
		// the visible window stays live, not every size it passed through.
		{ windowArg: 'limit' }
	);

	const { data: membersData, isLoading: membersLoading } = useConvexQuery(
		api.chat.members.listRoomMembers,
		() => (roomId.value ? { roomId: roomId.value } : 'skip')
	);

	const { data: linkedThread } = useConvexQuery(api.chat.emailLink.getLinkedThreadView, () =>
		roomId.value ? { roomId: roomId.value } : 'skip'
	);

	const messages = computed(() => messagesData.value?.messages ?? []);
	const hasMoreMessages = computed(() => messagesData.value?.hasMore ?? false);
	const members = computed(() => membersData.value ?? []);

	const { run: sendMessageMutation } = useBackendOperation(api.chat.messages.sendMessage, {
		label: () => t('shared.chat.useChatRoom.sendMessage'),
	});
	const { run: editMessageMutation } = useBackendOperation(api.chat.messages.editMessage, {
		label: () => t('shared.chat.useChatRoom.editMessage'),
	});
	const { run: deleteMessageMutation } = useBackendOperation(api.chat.messages.deleteMessage, {
		label: () => t('shared.chat.useChatRoom.deleteMessage'),
	});
	const { run: markReadMutation } = useBackendOperation(api.chat.messages.markRead, {
		label: () => t('shared.chat.useChatRoom.markRoomRead'),
		// Runs off the subscription, not off a click: announcing it is noise.
		announce: false,
	});
	const { run: joinChannelMutation } = useBackendOperation(api.chat.members.joinChannel, {
		label: () => t('shared.chat.useChatRoom.joinChannel'),
	});
	const { run: leaveRoomMutation } = useBackendOperation(api.chat.members.leaveRoom, {
		label: () => t('shared.chat.useChatRoom.leaveRoom'),
	});

	/**
	 * Send into the open room. The outcome goes back to the composer, which
	 * keeps the draft until the send is `ok` — a failure has already been
	 * toasted by the operation, so the draft is all the caller has to keep.
	 */
	const sendMessage = async (
		text: string,
		attachmentIds?: Id<'mediaAssets'>[]
	): Promise<BackendOperationResult<Id<'chatMessages'>>> => {
		if (!roomId.value) return { ok: false };
		return await sendMessageMutation({
			roomId: roomId.value,
			text,
			attachmentIds,
		});
	};

	const editMessage = async (messageId: Id<'chatMessages'>, text: string) => {
		return await editMessageMutation({ messageId, text });
	};

	const deleteMessage = async (messageId: Id<'chatMessages'>) => {
		return await deleteMessageMutation({ messageId });
	};

	const joinChannel = async () => {
		if (!roomId.value) return;
		await joinChannelMutation({ roomId: roomId.value });
	};

	const leaveRoom = async () => {
		if (!roomId.value) return;
		await leaveRoomMutation({ roomId: roomId.value });
	};

	// Read acknowledgement. The room is marked read up to the newest message
	// ON SCREEN — its createdAt, not the clock, so a message that lands after
	// the rendered snapshot stays unread — and only while this tab is visible:
	// a hidden tab leaves new messages and mentions unread, and coming back
	// acknowledges what is displayed then.
	//
	// The point is a number derived from the message list alone. The write
	// moves `myLastReadAt`, which re-emits the room; that emission recomputes
	// the same number, so the watcher does not fire again. (Watching the room
	// object itself turned every acknowledgement into the next one.)
	const isTabVisible = ref(
		typeof document === 'undefined' || document.visibilityState !== 'hidden'
	);
	if (typeof document !== 'undefined') {
		const onVisibilityChange = () => {
			isTabVisible.value = document.visibilityState !== 'hidden';
		};
		document.addEventListener('visibilitychange', onVisibilityChange);
		onScopeDispose(() => document.removeEventListener('visibilitychange', onVisibilityChange));
	}

	const readPoint = computed<number | null>(() => {
		const id = roomId.value;
		if (!id || !isTabVisible.value) return null;
		if (room.value?._id !== id || !room.value.isMember) return null;
		// Both subscriptions re-key on a room switch; until the list answers for
		// the new room it still holds the previous room's messages.
		const newest = messages.value.at(-1);
		if (!newest || newest.roomId !== id) return null;
		return newest.createdAt;
	});

	// The highest point sent for the current room (in flight or landed), so a
	// point is written once. A different room starts over.
	let acknowledged: { roomId: Id<'chatRooms'>; at: number } | null = null;
	watch(
		[roomId, readPoint],
		async ([id, at]) => {
			if (!id || at === null) return;
			const previous = acknowledged?.roomId === id ? acknowledged : null;
			if (previous && at <= previous.at) return;
			const current = { roomId: id, at };
			acknowledged = current;
			const outcome = await markReadMutation({ roomId: id, at });
			// Failed: forget the point so the next new message or the next return
			// to the tab tries again — never an immediate retry loop.
			if (!outcome.ok && acknowledged === current) acknowledged = previous;
		},
		{ immediate: true, flush: 'post' }
	);

	return {
		room,
		roomLoading,
		roomError,
		refetchRoom,
		messages,
		messagesLoading,
		messagesError,
		refetchMessages,
		hasMoreMessages,
		loadMoreMessages,
		atMaxMessages,
		members,
		membersLoading,
		linkedThread,
		sendMessage,
		editMessage,
		deleteMessage,
		joinChannel,
		leaveRoom,
	};
}
