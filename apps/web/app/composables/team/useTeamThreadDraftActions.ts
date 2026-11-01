import { ref, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { useThreadDetail } from '~/composables/useThreadDetail';
import { inboxRetryToast } from '~/utils/inboxRetry';

/**
 * What a Team Inbox thread does to one message's agent work: retry a failed
 * message and cancel a pending auto-send. Failures are toasted by the
 * operations themselves, so only success is said here.
 */
export function useTeamThreadDraftActions(options: {
	isAdmin: Ref<boolean>;
	detail: Pick<ReturnType<typeof useThreadDetail>, 'handleRetry'>;
}) {
	const { t } = useI18n();
	const { showToast } = useToast();

	const isRetrying = ref(false);
	const { run: undoAutoSend, isLoading: isUndoingAutoSend } = useBackendOperation(
		api.inbox.mutations.undoAutoSend,
		{ label: () => t('dashboard.inbox.detail.undoAutoSendOperation') }
	);

	async function cancelAutoSend(messageId: Id<'inboundMessages'>) {
		if (!options.isAdmin.value) return;
		const result = await undoAutoSend({ inboundMessageId: messageId });
		if (result.ok && result.result.cancelled)
			showToast(t('dashboard.inbox.detail.autoSendCancelledToast'));
	}

	const onRetry = async (messageId: Id<'inboundMessages'>) => {
		isRetrying.value = true;
		try {
			const result = await options.detail.handleRetry(messageId);
			if (result.ok) showToast(t(inboxRetryToast(result.result.retried)));
		} finally {
			isRetrying.value = false;
		}
	};

	return { isRetrying, onRetry, isUndoingAutoSend, cancelAutoSend };
}
