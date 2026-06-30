import { computed, ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const REGENERATED_SECRET_KEY = 'webhook-regenerated-secret';

/**
 * Composable for webhook toggle, regenerate secret, and delete operations.
 */
export function useWebhookActions(showNotification: (message: string, type?: 'success' | 'error') => void) {
	const { copy, isCopied, reset: resetCopied } = useCopyToClipboard();
	const { run: toggleWebhookMutation } = useBackendOperation(api.webhooks.endpoints.toggle, {
		label: 'Toggle webhook',
	});
	const { run: regenerateSecretMutation } = useBackendOperation(api.webhooks.endpoints.regenerateSecret, {
		label: 'Regenerate webhook secret',
	});
	const { run: deleteWebhookMutation } = useBackendOperation(api.webhooks.endpoints.remove, {
		label: 'Delete webhook',
	});

	// --- Toggle ---
	const togglingWebhookId = ref<Id<'webhooks'> | null>(null);

	const handleToggle = async (webhookId: Id<'webhooks'>) => {
		togglingWebhookId.value = webhookId;
		const result = await toggleWebhookMutation({ webhookId });
		togglingWebhookId.value = null;
		if (result === undefined) return;
		showNotification(result.isActive ? 'Webhook enabled' : 'Webhook disabled');
	};

	// --- Regenerate Secret ---
	const isRegenerateModalOpen = ref(false);
	const webhookToRegenerate = ref<{ id: Id<'webhooks'>; name: string } | null>(null);
	const isRegenerating = ref(false);
	const regeneratedSecret = ref<string | null>(null);
	const copiedRegeneratedSecret = computed(() => isCopied(REGENERATED_SECRET_KEY));

	const openRegenerateModal = (id: Id<'webhooks'>, name: string) => {
		webhookToRegenerate.value = { id, name };
		regeneratedSecret.value = null;
		resetCopied();
		isRegenerateModalOpen.value = true;
	};

	const closeRegenerateModal = () => {
		isRegenerateModalOpen.value = false;
		webhookToRegenerate.value = null;
		regeneratedSecret.value = null;
		resetCopied();
	};

	const handleRegenerate = async () => {
		if (!webhookToRegenerate.value) return;

		isRegenerating.value = true;
		const result = await regenerateSecretMutation({
			webhookId: webhookToRegenerate.value.id,
		});
		isRegenerating.value = false;
		if (result === undefined) {
			closeRegenerateModal();
			return;
		}
		regeneratedSecret.value = result.secret ?? null;
		showNotification('Webhook secret regenerated');
	};

	const copyRegeneratedSecret = async () => {
		if (!regeneratedSecret.value) return;

		const ok = await copy(regeneratedSecret.value, REGENERATED_SECRET_KEY);
		if (!ok) {
			showNotification('Failed to copy to clipboard', 'error');
		}
	};

	// --- Delete ---
	const isDeleteModalOpen = ref(false);
	const webhookToDelete = ref<{ id: Id<'webhooks'>; name: string } | null>(null);
	const isDeleting = ref(false);

	const openDeleteModal = (id: Id<'webhooks'>, name: string) => {
		webhookToDelete.value = { id, name };
		isDeleteModalOpen.value = true;
	};

	const closeDeleteModal = () => {
		isDeleteModalOpen.value = false;
		webhookToDelete.value = null;
	};

	const handleDelete = async () => {
		if (!webhookToDelete.value) return;

		isDeleting.value = true;
		const result = await deleteWebhookMutation({ webhookId: webhookToDelete.value.id });
		isDeleting.value = false;
		if (result === undefined) return;
		showNotification('Webhook deleted');
		closeDeleteModal();
	};

	return {
		// Toggle
		togglingWebhookId,
		handleToggle,

		// Regenerate
		isRegenerateModalOpen,
		webhookToRegenerate,
		isRegenerating,
		regeneratedSecret,
		copiedRegeneratedSecret,
		openRegenerateModal,
		closeRegenerateModal,
		handleRegenerate,
		copyRegeneratedSecret,

		// Delete
		isDeleteModalOpen,
		webhookToDelete,
		isDeleting,
		openDeleteModal,
		closeDeleteModal,
		handleDelete,
	};
}
