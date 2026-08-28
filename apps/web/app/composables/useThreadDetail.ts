import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { categoryIcon } from '~/utils/agentCategories';

export function useThreadDetail(threadId: Ref<Id<'conversationThreads'>>) {
	const { t, locale } = useI18n();

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
	// Each step toasts its own categorized failure and resolves to `ok: false`,
	// so a failed save short-circuits before approval.
	const saveEditedDraft = async (messageId: Id<'inboundMessages'>) => {
		const saved = await editDraft({
			inboundMessageId: messageId,
			draftResponse: editedDraftResponse.value,
			draftSubject: editedDraftSubject.value || undefined,
		});
		if (!saved.ok) return saved;

		const approved = await approveDraft({ inboundMessageId: messageId });
		if (!approved.ok) return approved;

		isEditingDraft.value = false;
		return approved;
	};

	// Inline "Save" (piece D1'): persist the working edit as a draft revision
	// WITHOUT approving — the message stays in `draft_ready`, the agent original
	// is preserved as revision 0, and no autonomy feedback is recorded. Editing
	// mode closes on success; the saved text becomes the visible working draft.
	const saveDraftOnly = async (messageId: Id<'inboundMessages'>) => {
		const saved = await saveDraftRevision({
			inboundMessageId: messageId,
			draftResponse: editedDraftResponse.value,
			draftSubject: editedDraftSubject.value || undefined,
		});
		if (!saved.ok) return saved;

		isEditingDraft.value = false;
		return saved;
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

	const PROCESSING_STATUS_KEYS: Record<string, string> = {
		received: 'shared.useThreadDetail.processingStatus.received',
		processing: 'shared.useThreadDetail.processingStatus.processing',
		classified: 'shared.useThreadDetail.processingStatus.classified',
		draft_ready: 'shared.useThreadDetail.processingStatus.draftReady',
		approved: 'shared.useThreadDetail.processingStatus.approved',
		sent: 'shared.useThreadDetail.processingStatus.sent',
		quarantined: 'shared.useThreadDetail.processingStatus.quarantined',
		failed: 'shared.useThreadDetail.processingStatus.failed',
	};

	// An unknown status has no message of its own — it renders as the raw value,
	// exactly as it always has, rather than as a missing key.
	const getProcessingStatusLabel = (status: string) => {
		const key = PROCESSING_STATUS_KEYS[status];
		return key === undefined ? status : t(key);
	};

	const getCategoryIcon = categoryIcon;

	const formatTimestamp = (timestamp: number) => {
		return new Date(timestamp).toLocaleString(locale.value);
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
		saveDraftOnly,
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
