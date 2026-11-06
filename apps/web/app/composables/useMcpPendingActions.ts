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

	const approveOperation = useBackendOperation(api.mcp.actions.approve, {
		label: () => t('shared.useMcpPendingActions.approveOperation'),
	});
	const rejectOperation = useBackendOperation(api.mcp.actions.reject, {
		label: () => t('shared.useMcpPendingActions.rejectOperation'),
	});
	const { showToast } = useToast();

	async function approve(actionId: Id<'mcpPendingActions'>) {
		busyId.value = actionId;
		try {
			const outcome = await approveOperation.run({ actionId });
			if (!outcome.ok) return;
			const { status, failureMessage } = outcome.result;
			if (status === 'failed') {
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

	return { pending, isLoading, error, refetch, busyId, approve, reject };
}
