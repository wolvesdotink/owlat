import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * State + actions for the personal AI assistant (`/dashboard/assistant`):
 * the owner's conversation list, the active conversation's reactive message
 * feed (which streams as the runner patches the assistant row), and the
 * create/send/stop/rename/delete operations.
 */
export function useAssistant() {
	const { t } = useI18n();
	const activeId = ref<Id<'aiConversations'> | null>(null);

	const {
		data: conversationsData,
		isLoading: conversationsLoading,
		error: conversationsError,
		refetch: refetchConversations,
	} = useConvexQuery(api.assistant.conversations.listConversations, {});
	const conversations = computed(() => conversationsData.value ?? []);

	const {
		data: messagesData,
		isLoading: messagesLoading,
		error: messagesError,
		refetch: refetchMessages,
	} = useConvexQuery(api.assistant.conversations.listMessages, () =>
		activeId.value ? { conversationId: activeId.value } : 'skip'
	);
	const messages = computed(() => messagesData.value ?? []);

	const activeConversation = computed(
		() => conversations.value.find((c) => c._id === activeId.value) ?? null
	);

	/** True while the active conversation has an assistant turn still streaming. */
	const streaming = computed(() =>
		messages.value.some((m) => m.role === 'assistant' && m.status === 'streaming')
	);

	const { run: createRun } = useBackendOperation(api.assistant.conversations.createConversation, {
		label: () => t('shared.useAssistant.newConversation'),
	});
	const { run: sendRun } = useBackendOperation(api.assistant.conversations.sendMessage, {
		label: () => t('shared.useAssistant.sendMessage'),
	});
	const { run: stopRun } = useBackendOperation(api.assistant.conversations.stopGeneration, {
		label: () => t('shared.useAssistant.stopGeneration'),
	});
	const { run: renameRun } = useBackendOperation(api.assistant.conversations.renameConversation, {
		label: () => t('shared.useAssistant.renameConversation'),
	});
	const { run: deleteRun } = useBackendOperation(api.assistant.conversations.deleteConversation, {
		label: () => t('shared.useAssistant.deleteConversation'),
	});

	const selectConversation = (id: Id<'aiConversations'>) => {
		activeId.value = id;
	};

	const newConversation = async (): Promise<Id<'aiConversations'> | undefined> => {
		const created = await createRun({});
		if (!created.ok) return undefined;
		activeId.value = created.result;
		return created.result;
	};

	/**
	 * Send a question to the open conversation, creating one first when none is
	 * open. Resolves `ok` only once the message is accepted, so the composer can
	 * keep the question until then. A conversation created here becomes the
	 * active one before the message goes out: if the message then fails, the
	 * retry finds it open and sends into it instead of creating a second, empty
	 * conversation.
	 */
	const send = async (text: string): Promise<{ ok: boolean }> => {
		let id = activeId.value;
		if (!id) {
			const created = await createRun({});
			if (!created.ok) return { ok: false };
			id = created.result;
			activeId.value = id;
		}
		const sent = await sendRun({ conversationId: id, text });
		return { ok: sent.ok };
	};

	const stop = async () => {
		const streamingMsg = messages.value.find(
			(m) => m.role === 'assistant' && m.status === 'streaming'
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
		{ immediate: true }
	);

	return {
		activeId,
		conversations,
		conversationsLoading,
		conversationsError,
		refetchConversations,
		messages,
		messagesLoading,
		messagesError,
		refetchMessages,
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
