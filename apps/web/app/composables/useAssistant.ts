import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * State + actions for the personal AI assistant (`/dashboard/assistant`):
 * the owner's conversation list, the active conversation's reactive message
 * feed (which streams as the runner patches the assistant row), and the
 * create/send/stop/rename/delete operations.
 */
export function useAssistant() {
	const activeId = ref<Id<'aiConversations'> | null>(null);

	const { data: conversationsData, isLoading: conversationsLoading } = useConvexQuery(
		api.assistant.conversations.listConversations,
		{},
	);
	const conversations = computed(() => conversationsData.value ?? []);

	const { data: messagesData, isLoading: messagesLoading } = useConvexQuery(
		api.assistant.conversations.listMessages,
		() => (activeId.value ? { conversationId: activeId.value } : 'skip'),
	);
	const messages = computed(() => messagesData.value ?? []);

	const activeConversation = computed(
		() => conversations.value.find((c) => c._id === activeId.value) ?? null,
	);

	/** True while the active conversation has an assistant turn still streaming. */
	const streaming = computed(() =>
		messages.value.some((m) => m.role === 'assistant' && m.status === 'streaming'),
	);

	const { run: createRun } = useBackendOperation(api.assistant.conversations.createConversation, {
		label: 'New conversation',
	});
	const { run: sendRun } = useBackendOperation(api.assistant.conversations.sendMessage, {
		label: 'Send message',
	});
	const { run: stopRun } = useBackendOperation(api.assistant.conversations.stopGeneration, {
		label: 'Stop generating',
	});
	const { run: renameRun } = useBackendOperation(api.assistant.conversations.renameConversation, {
		label: 'Rename conversation',
	});
	const { run: deleteRun } = useBackendOperation(api.assistant.conversations.deleteConversation, {
		label: 'Delete conversation',
	});

	const selectConversation = (id: Id<'aiConversations'>) => {
		activeId.value = id;
	};

	const newConversation = async (): Promise<Id<'aiConversations'> | undefined> => {
		const id = await createRun({});
		if (id) activeId.value = id;
		return id ?? undefined;
	};

	const send = async (text: string) => {
		let id = activeId.value;
		if (!id) {
			id = (await createRun({})) ?? null;
			if (id) activeId.value = id;
		}
		if (!id) return;
		await sendRun({ conversationId: id, text });
	};

	const stop = async () => {
		const streamingMsg = messages.value.find(
			(m) => m.role === 'assistant' && m.status === 'streaming',
		);
		if (streamingMsg) await stopRun({ messageId: streamingMsg._id });
	};

	const rename = async (conversationId: Id<'aiConversations'>, title: string) => {
		await renameRun({ conversationId, title });
	};

	const remove = async (conversationId: Id<'aiConversations'>) => {
		await deleteRun({ conversationId });
		if (activeId.value === conversationId) activeId.value = null;
	};

	// Auto-select the most-recent conversation once the list loads.
	watch(
		conversations,
		(list) => {
			if (!activeId.value && list.length > 0) activeId.value = list[0]!._id;
		},
		{ immediate: true },
	);

	return {
		activeId,
		conversations,
		conversationsLoading,
		messages,
		messagesLoading,
		activeConversation,
		streaming,
		selectConversation,
		newConversation,
		send,
		stop,
		rename,
		remove,
	};
}
