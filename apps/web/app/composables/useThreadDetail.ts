import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function useThreadDetail(threadId: Ref<Id<'conversationThreads'>>) {
	const { t } = useI18n();

	// Fetch thread with messages
	const { data: threadData, isLoading: threadLoading } = useConvexQuery(
		api.inbox.queries.getThread,
		() => ({ threadId: threadId.value })
	);

	const thread = computed(() => threadData.value?.thread ?? null);
	const messages = computed(() => threadData.value?.messages ?? []);
	const contact = computed(() => threadData.value?.contact ?? null);

	// Mutations
	const { run: approveDraft } = useBackendOperation(api.inbox.mutations.approveDraft, {
		label: () => t('shared.useThreadDetail.approveDraft'),
	});
	const { run: rejectDraft } = useBackendOperation(api.inbox.mutations.rejectDraft, {
		label: () => t('shared.useThreadDetail.rejectDraft'),
	});
	const { run: editDraft } = useBackendOperation(api.inbox.mutations.editDraft, {
		label: () => t('shared.useThreadDetail.saveDraft'),
	});
	const { run: assignThread } = useBackendOperation(api.inbox.mutations.assignThread, {
		label: () => t('shared.useThreadDetail.assignThread'),
	});
	const { run: updateThreadStatus } = useBackendOperation(api.inbox.mutations.updateThreadStatus, {
		label: () => t('shared.useThreadDetail.updateThreadStatus'),
	});
	const { run: retryFailedMessage } = useBackendOperation(api.inbox.mutations.retryFailedMessage, {
		label: () => t('shared.useThreadDetail.retryMessage'),
	});
	const { run: snoozeThread } = useBackendOperation(api.inbox.snooze.snoozeThread, {
		label: () => t('shared.useThreadDetail.snoozeThread'),
	});
	const { run: unsnoozeThread } = useBackendOperation(api.inbox.snooze.unsnoozeThread, {
		label: () => t('shared.useThreadDetail.unsnoozeThread'),
	});
	// Declared AFTER the operations above: the unit tests map mocked runs by
	// declaration order.
	const { run: saveDraftRevision } = useBackendOperation(
		api.inbox.draftRevisions.saveDraftRevision,
		{ label: () => t('shared.useThreadDetail.saveDraftRevision') }
	);

	// Actions
	// Return the run result so callers can show a success toast only on a real
	// success — `useBackendOperation.run` resolves to `undefined` (and has
	// already toasted) on a categorized failure, so it never throws here.
	const handleApprove = async (messageId: Id<'inboundMessages'>) => {
		return await approveDraft({ inboundMessageId: messageId });
	};

	const handleReject = async (messageId: Id<'inboundMessages'>, reason?: string) => {
		return await rejectDraft({ inboundMessageId: messageId, reason });
	};

	const handleRetry = async (messageId: Id<'inboundMessages'>) => {
		return await retryFailedMessage({ inboundMessageId: messageId });
	};

	/** The reply a person wrote: its body, and the subject (blank = keep the default). */
	interface ReplyText {
		body: string;
		subject: string;
	}

	// Send a person's reply: persist it as the working draft, then approve it so
	// the message transitions to `approved` and is queued for sending. `editDraft`
	// only patches the draft text (leaving the message in `draft_ready`), so the
	// follow-up `approveDraft` reads the just-saved text and fires the transition.
	// Each step toasts its own categorized failure and resolves to `ok: false`,
	// so a failed save short-circuits before approval.
	const saveEditedDraft = async (messageId: Id<'inboundMessages'>, reply: ReplyText) => {
		const saved = await editDraft({
			inboundMessageId: messageId,
			draftResponse: reply.body,
			draftSubject: reply.subject || undefined,
		});
		if (!saved.ok) return saved;
		return await approveDraft({ inboundMessageId: messageId });
	};

	// Save WITHOUT sending: persist the edit as a draft revision — the message
	// stays in `draft_ready`, the agent original is preserved as revision 0, and
	// no autonomy feedback is recorded.
	const saveDraftOnly = async (messageId: Id<'inboundMessages'>, reply: ReplyText) => {
		return await saveDraftRevision({
			inboundMessageId: messageId,
			draftResponse: reply.body,
			draftSubject: reply.subject || undefined,
		});
	};

	const handleAssign = async (assignedTo?: string) => {
		await assignThread({ threadId: threadId.value, assignedTo });
	};

	const handleStatusChange = async (status: 'open' | 'waiting' | 'resolved' | 'closed') => {
		await updateThreadStatus({ threadId: threadId.value, status });
	};

	// Snooze the thread until `until` (ms epoch); it leaves the Open filter and
	// the wake cron floats it back with a "returned" marker at that time.
	const handleSnooze = async (until: number) => {
		return await snoozeThread({ threadId: threadId.value, until });
	};

	const handleUnsnooze = async () => {
		return await unsnoozeThread({ threadId: threadId.value });
	};

	return {
		// Data
		thread,
		messages,
		contact,
		threadLoading,
		// Actions
		handleApprove,
		handleReject,
		handleRetry,
		saveEditedDraft,
		saveDraftOnly,
		handleAssign,
		handleStatusChange,
		handleSnooze,
		handleUnsnooze,
	};
}
