import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { categoryIcon } from '~/utils/agentCategories';

export function useThreadDetail(threadId: Ref<Id<'conversationThreads'>>) {
	// Fetch thread with messages
	const { data: threadData, isLoading: threadLoading } = useConvexQuery(
		api.inbox.queries.getThread,
		() => ({ threadId: threadId.value })
	);

	const thread = computed(() => threadData.value?.thread ?? null);
	const messages = computed(() => threadData.value?.messages ?? []);
	const contact = computed(() => threadData.value?.contact ?? null);

	// Draft editing state
	const isEditingDraft = ref(false);
	const editedDraftResponse = ref('');
	const editedDraftSubject = ref('');

	// Mutations
	const { run: approveDraft } = useBackendOperation(api.inbox.mutations.approveDraft, {
		label: 'Approve draft',
	});
	const { run: rejectDraft } = useBackendOperation(api.inbox.mutations.rejectDraft, {
		label: 'Reject draft',
	});
	const { run: editDraft } = useBackendOperation(api.inbox.mutations.editDraft, {
		label: 'Save draft',
	});
	const { run: assignThread } = useBackendOperation(api.inbox.mutations.assignThread, {
		label: 'Assign thread',
	});
	const { run: updateThreadStatus } = useBackendOperation(api.inbox.mutations.updateThreadStatus, {
		label: 'Update thread status',
	});
	const { run: retryFailedMessage } = useBackendOperation(api.inbox.mutations.retryFailedMessage, {
		label: 'Retry message',
	});
	const { run: snoozeThread } = useBackendOperation(api.inbox.snooze.snoozeThread, {
		label: 'Snooze thread',
	});
	const { run: unsnoozeThread } = useBackendOperation(api.inbox.snooze.unsnoozeThread, {
		label: 'Unsnooze thread',
	});

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

	const startEditDraft = (message: {
		draftResponse?: string | null;
		draftSubject?: string | null;
	}) => {
		editedDraftResponse.value = message.draftResponse ?? '';
		editedDraftSubject.value = message.draftSubject ?? '';
		isEditingDraft.value = true;
	};

	const cancelEditDraft = () => {
		isEditingDraft.value = false;
		editedDraftResponse.value = '';
		editedDraftSubject.value = '';
	};

	// "Save & Approve": persist the edited draft, then approve it so the message
	// transitions to `approved` and is queued for sending. `editDraft` only
	// patches the draft text (leaving the message in `draft_ready`), so the
	// follow-up `approveDraft` reads the just-saved text and fires the transition.
	// Each step toasts its own categorized failure and resolves to `undefined`,
	// so a failed save short-circuits before approval.
	const saveEditedDraft = async (messageId: Id<'inboundMessages'>) => {
		const saved = await editDraft({
			inboundMessageId: messageId,
			draftResponse: editedDraftResponse.value,
			draftSubject: editedDraftSubject.value || undefined,
		});
		if (saved === undefined) return undefined;

		const approved = await approveDraft({ inboundMessageId: messageId });
		if (approved === undefined) return undefined;

		isEditingDraft.value = false;
		return approved;
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

	// Processing status helpers
	const getProcessingStatusColor = (status: string) => {
		const colors: Record<string, string> = {
			received: 'text-text-tertiary bg-bg-surface',
			processing: 'text-brand bg-brand-subtle',
			classified: 'text-brand bg-brand-subtle',
			draft_ready: 'text-warning bg-warning/10',
			approved: 'text-success bg-success-subtle',
			sent: 'text-success bg-success-subtle',
			quarantined: 'text-error bg-error-subtle',
			failed: 'text-error bg-error-subtle',
		};
		return colors[status] || 'text-text-tertiary bg-bg-surface';
	};

	const getProcessingStatusLabel = (status: string) => {
		const labels: Record<string, string> = {
			received: 'Received',
			processing: 'Processing',
			classified: 'Classified',
			draft_ready: 'Draft Ready',
			approved: 'Approved',
			sent: 'Sent',
			quarantined: 'Quarantined',
			failed: 'Failed',
		};
		return labels[status] || status;
	};

	const getCategoryIcon = categoryIcon;

	const formatTimestamp = (timestamp: number) => {
		return new Date(timestamp).toLocaleString();
	};

	return {
		// Data
		thread,
		messages,
		contact,
		threadLoading,
		// Draft editing
		isEditingDraft,
		editedDraftResponse,
		editedDraftSubject,
		// Actions
		handleApprove,
		handleReject,
		handleRetry,
		startEditDraft,
		cancelEditDraft,
		saveEditedDraft,
		handleAssign,
		handleStatusChange,
		handleSnooze,
		handleUnsnooze,
		// Helpers
		getProcessingStatusColor,
		getProcessingStatusLabel,
		getCategoryIcon,
		formatTimestamp,
	};
}
