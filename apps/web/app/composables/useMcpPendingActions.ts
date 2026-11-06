/**
 * Writes the member's AI clients asked for and that wait for their approval
 * (`mcp/actions.ts`): the list, and approve or reject one. Subscribed only
 * while the MCP server is on, so the shell pays nothing on other instances.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';

export type McpPendingAction = FunctionReturnType<typeof api.mcp.actions.listPending>[number];

export function useMcpPendingActions() {
	const { t } = useI18n();
	const { isEnabled } = useFeatureFlag();
	const { data, isLoading, error, refetch } = useConvexQuery(api.mcp.actions.listPending, () =>
		isEnabled('mail.mcp') ? {} : 'skip'
	);
	const pending = computed(() => data.value ?? []);
	const busyId = ref<Id<'mcpPendingActions'> | null>(null);
	/** Why the last approval of an action was refused, by action id. */
	const notices = ref<Record<string, string>>({});

	const approveOperation = useBackendOperation(api.mcp.actions.approve, {
		label: () => t('shared.useMcpPendingActions.approveOperation'),
	});
	const rejectOperation = useBackendOperation(api.mcp.actions.reject, {
		label: () => t('shared.useMcpPendingActions.rejectOperation'),
	});
	const { showToast } = useToast();

	/**
	 * Approve the action as its card shows it. The server refuses when what
	 * would run changed since (`isChanged`); the list has refreshed by then, so
	 * the card says why and waits for another look.
	 */
	async function approve(action: Pick<McpPendingAction, '_id' | 'reviewDigest'>) {
		const actionId = action._id;
		if (!action.reviewDigest) return;
		busyId.value = actionId;
		delete notices.value[actionId];
		try {
			const outcome = await approveOperation.run({ actionId, reviewDigest: action.reviewDigest });
			if (!outcome.ok) return;
			const { status, failureMessage, isChanged } = outcome.result;
			if (isChanged) {
				notices.value[actionId] = t('shared.useMcpPendingActions.changed');
			} else if (status === 'failed') {
				showToast(
					t('shared.useMcpPendingActions.failed', {
						reason: failureMessage ?? t('shared.useMcpPendingActions.failedUnknown'),
					}),
					'error'
				);
			} else if (status === 'expired') {
				showToast(t('shared.useMcpPendingActions.expired'), 'error');
			}
		} finally {
			busyId.value = null;
		}
	}

	async function reject(actionId: Id<'mcpPendingActions'>) {
		busyId.value = actionId;
		try {
			await rejectOperation.run({ actionId });
		} finally {
			busyId.value = null;
		}
	}

	return { pending, isLoading, error, refetch, busyId, notices, approve, reject };
}
