import { ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function useWebhookDeliveryLogs(
	showNotification: (message: string, type?: 'success' | 'error') => void
) {
	// Modal state
	const isLogsModalOpen = ref(false);
	const logsWebhookId = ref<Id<'webhooks'> | null>(null);
	const logsWebhookName = ref('');

	// Selected log detail
	const selectedLogId = ref<Id<'webhookDeliveryLogs'> | null>(null);

	// Send test state
	const isSendingTest = ref(false);
	const { run: sendTestMutation } = useBackendOperation(api.webhooks.endpoints.sendTestWebhook, {
		label: 'Send test webhook',
	});

	// Queries — skip when no webhookId
	const { data: logs, isLoading: logsLoading } = useConvexQuery(
		api.webhooks.endpoints.listDeliveryLogs,
		() => (logsWebhookId.value ? { webhookId: logsWebhookId.value } : 'skip')
	);

	const { data: stats } = useConvexQuery(
		api.webhooks.endpoints.getDeliveryStats,
		() => (logsWebhookId.value ? { webhookId: logsWebhookId.value } : 'skip')
	);

	const { data: selectedLog } = useConvexQuery(
		api.webhooks.endpoints.getDeliveryLog,
		() => (selectedLogId.value ? { logId: selectedLogId.value } : 'skip')
	);

	const openLogsModal = (webhookId: Id<'webhooks'>, webhookName: string) => {
		logsWebhookId.value = webhookId;
		logsWebhookName.value = webhookName;
		selectedLogId.value = null;
		isLogsModalOpen.value = true;
	};

	const closeLogsModal = () => {
		isLogsModalOpen.value = false;
		logsWebhookId.value = null;
		logsWebhookName.value = '';
		selectedLogId.value = null;
	};

	const selectLog = (logId: Id<'webhookDeliveryLogs'>) => {
		selectedLogId.value = logId;
	};

	const clearSelectedLog = () => {
		selectedLogId.value = null;
	};

	const handleSendTest = async (webhookId: Id<'webhooks'>) => {
		isSendingTest.value = true;
		const result = await sendTestMutation({ webhookId });
		isSendingTest.value = false;
		if (result === undefined) return;
		showNotification('Test webhook sent');
	};

	return {
		// Modal
		isLogsModalOpen,
		logsWebhookName,
		logsWebhookId,
		openLogsModal,
		closeLogsModal,

		// Logs
		logs,
		logsLoading,
		stats,

		// Log detail
		selectedLogId,
		selectedLog,
		selectLog,
		clearSelectedLog,

		// Send test
		isSendingTest,
		handleSendTest,
	};
}
