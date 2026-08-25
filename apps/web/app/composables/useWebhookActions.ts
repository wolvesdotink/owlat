import { computed, ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const REGENERATED_SECRET_KEY = 'webhook-regenerated-secret';

/**
 * Composable for webhook toggle, regenerate secret, and delete operations.
 */
export function useWebhookActions(
	showNotification: (message: string, type?: 'success' | 'error') => void
) {
	const { t } = useI18n();
	const { copy, isCopied, reset: resetCopied } = useCopyToClipboard();
	const { run: toggleWebhookMutation } = useBackendOperation(api.webhooks.endpoints.toggle, {
		label: () => t('shared.useWebhookActions.toggleWebhook'),
	});
	const { run: regenerateSecretMutation } = useBackendOperation(
		api.webhooks.endpoints.regenerateSecret,
		{
			label: () => t('shared.useWebhookActions.regenerateSecret'),
		}
	);
	const { run: deleteWebhookMutation } = useBackendOperation(api.webhooks.endpoints.remove, {
		label: () => t('shared.useWebhookActions.deleteWebhook'),
	});

	// --- Toggle ---
	const togglingWebhookId = ref<Id<'webhooks'> | null>(null);

	const handleToggle = async (webhookId: Id<'webhooks'>) => {
		togglingWebhookId.value = webhookId;
		const result = await toggleWebhookMutation({ webhookId });
		togglingWebhookId.value = null;
		if (!result.ok) return;
		showNotification(
			result.result.isActive
				? t('shared.useWebhookActions.webhookEnabled')
				: t('shared.useWebhookActions.webhookDisabled')
		);
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
		if (!result.ok) {
			closeRegenerateModal();
			return;
		}
		regeneratedSecret.value = result.result.secret ?? null;
		showNotification(t('shared.useWebhookActions.secretRegenerated'));
	};

	const copyRegeneratedSecret = async () => {
		if (!regeneratedSecret.value) return;

		const ok = await copy(regeneratedSecret.value, REGENERATED_SECRET_KEY);
		if (!ok) {
			showNotification(t('shared.useWebhookActions.copyFailed'), 'error');
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
		if (!result.ok) return;
		showNotification(t('shared.useWebhookActions.webhookDeleted'));
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
