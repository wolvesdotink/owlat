<script setup lang="ts">
import { api } from '@owlat/api';
import { UnsavedChangesDialog } from '@owlat/email-builder';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.delivery.webhooks.pageTitle') });

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'admin'],
});

// Get the current user's organization
const { hasActiveOrganization, isLoading: organizationLoading } = useOrganizationContext();

// Fetch webhooks with real-time updates
const { data: webhooks, isLoading: webhooksLoading } = useOrganizationQuery(
	api.webhooks.endpoints.listByOrganization,
	{ includeInactive: true }
);

const isLoading = computed(() => organizationLoading.value || webhooksLoading.value);

// Active webhooks count
const activeWebhooksCount = computed(() => {
	if (!webhooks.value) return 0;
	return webhooks.value.filter((webhook) => webhook.isActive).length;
});

// All webhook form logic from composable
const {
	// Create
	isCreateModalOpen,
	createForm,
	createFormError,
	isCreating,
	openCreateModal,
	closeCreateModal,
	toggleCreateEvent,
	selectAllEvents,
	clearAllEvents,
	handleCreate,

	// Created webhook secret display
	createdWebhook,
	showCreatedWebhook,
	copiedSecret,
	closeCreatedWebhookModal,
	copySecret,

	// Edit
	isEditModalOpen,
	editForm,
	editFormError,
	isEditing,
	openEditModal,
	closeEditModal,
	toggleEditEvent,
	handleEdit,

	// Toggle
	togglingWebhookId,
	handleToggle,

	// Regenerate secret
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

	// Utilities
	expandedWebhookId,
	toggleExpanded,
	showNotification,
} = useWebhookForm();

// Delivery logs
const {
	isLogsModalOpen,
	logsWebhookName,
	logsWebhookId,
	openLogsModal,
	closeLogsModal,
	logs: deliveryLogs,
	logsLoading: deliveryLogsLoading,
	stats: deliveryStats,
	selectedLogId,
	selectedLog,
	selectLog,
	clearSelectedLog,
	isSendingTest,
	handleSendTest,
} = useWebhookDeliveryLogs(showNotification);

// ── Unsaved-changes guard ───────────────────────────────────────────
// Both webhook forms live in modals, so their drafts exist only while the modal
// is up: a command-palette jump, a browser Back or a tab close used to drop an
// endpoint the operator had half-configured without a word. Dirtiness is
// measured against the seed — an empty create form, or the stored row an edit
// was opened on — so merely opening a modal never prompts.
const isCreateDirty = computed(
	() =>
		isCreateModalOpen.value &&
		(createForm.name.trim() !== '' || createForm.url.trim() !== '' || createForm.events.length > 0)
);

const isEditDirty = computed(() => {
	if (!isEditModalOpen.value) return false;
	const original = (webhooks.value ?? []).find((webhook) => webhook._id === editForm.id);
	if (!original) return false;
	const sorted = (events: readonly string[]) => [...events].sort().join(',');
	return (
		editForm.name !== original.name ||
		editForm.url !== original.url ||
		sorted(editForm.events) !== sorted(original.events)
	);
});

const {
	showDialog: showUnsavedDialog,
	confirmDiscard,
	confirmSave,
	cancelNavigation,
	setHasChanges,
} = useUnsavedChanges({
	onSave: async () => {
		await handleEdit();
		// `handleEdit` closes its modal only once the write lands; a refusal or a
		// validation stop leaves it open, and throwing keeps the operator here
		// with the draft intact instead of navigating away from it.
		if (isEditModalOpen.value) throw new Error('Save failed');
	},
});

watch([isCreateDirty, isEditDirty], ([create, edit]) => setHasChanges(create || edit), {
	immediate: true,
});

/**
 * Saving from the guard dialog. Editing routes through the composable's
 * `confirmSave`, which navigates once the write lands.
 *
 * Creating cannot: it answers with a signing secret that is shown exactly once,
 * in a modal on THIS page, so completing the create and then leaving would
 * destroy it. So the create path writes and then cancels the navigation — on
 * success there is a secret to read, on failure an inline error in the form, and
 * either way the operator belongs here.
 */
async function handleGuardSave() {
	if (isCreateModalOpen.value) {
		await handleCreate();
		cancelNavigation();
		return;
	}
	await confirmSave();
}
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
			<div>
				<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
					{{ t('dashboard.admin.delivery.webhooks.title') }}
				</h1>
				<p class="mt-1 text-text-secondary">
					{{ t('dashboard.admin.delivery.webhooks.lede') }}
				</p>
			</div>
			<UiButton class="gap-2" @click="openCreateModal">
				<Icon name="lucide:plus" class="w-4 h-4" />
				{{ t('dashboard.admin.delivery.webhooks.create') }}
			</UiButton>
		</div>

		<!-- Info Box -->
		<div class="card p-4 mb-6 bg-brand-subtle/50 border-brand/20">
			<div class="flex items-start gap-3">
				<Icon name="lucide:shield" class="w-5 h-5 text-brand shrink-0 mt-0.5" />
				<div>
					<p class="text-sm text-text-primary font-medium">
						{{ t('dashboard.admin.delivery.webhooks.secure.title') }}
					</p>
					<I18nT
						keypath="dashboard.admin.delivery.webhooks.secure.body"
						tag="p"
						class="text-sm text-text-secondary mt-1"
						scope="global"
					>
						<template #header>
							<code class="px-1.5 py-0.5 rounded bg-bg-surface text-text-primary text-xs font-mono"
								>X-Signature</code
							>
						</template>
					</I18nT>
				</div>
			</div>
		</div>

		<!-- Content -->
		<div>
			<!-- First-load skeleton (shaped like the webhook list) -->
			<div v-if="isLoading && !webhooks" class="card overflow-hidden">
				<DashboardListSkeleton variant="card" leading :rows="3" />
			</div>

			<!-- No workspace — a precondition, not an empty list, so the eyebrow
			     names the surface rather than claiming there is nothing here. -->
			<UiEmptyState
				v-else-if="!hasActiveOrganization"
				icon="lucide:webhook"
				:eyebrow="t('dashboard.admin.delivery.webhooks.title')"
				:title="t('dashboard.admin.delivery.webhooks.noWorkspace.title')"
				:description="t('dashboard.admin.delivery.webhooks.noWorkspace.description')"
			/>

			<!-- Empty State (no webhooks) -->
			<UiEmptyState
				v-else-if="!isLoading && (!webhooks || webhooks.length === 0)"
				icon="lucide:webhook"
				:title="t('dashboard.admin.delivery.webhooks.empty.title')"
				:description="t('dashboard.admin.delivery.webhooks.empty.description')"
			>
				<template #action>
					<UiButton class="gap-2" @click="openCreateModal">
						<Icon name="lucide:plus" class="w-4 h-4" />
						{{ t('dashboard.admin.delivery.webhooks.create') }}
					</UiButton>
				</template>
			</UiEmptyState>

			<!-- Webhooks List -->
			<div v-else class="space-y-4">
				<div class="text-sm text-text-secondary mb-2">
					{{
						t(
							'dashboard.admin.delivery.webhooks.activeCount',
							{ count: activeWebhooksCount },
							activeWebhooksCount
						)
					}}
				</div>

				<WebhooksWebhookRow
					v-for="webhook in webhooks"
					:key="webhook._id"
					:webhook="webhook"
					:expanded="expandedWebhookId === webhook._id"
					:toggling="togglingWebhookId === webhook._id"
					:sending-test="isSendingTest"
					@toggle-expanded="toggleExpanded(webhook._id)"
					@toggle-active="handleToggle(webhook._id)"
					@edit="openEditModal(webhook)"
					@send-test="handleSendTest(webhook._id)"
					@view-logs="openLogsModal(webhook._id, webhook.name)"
					@regenerate="openRegenerateModal(webhook._id, webhook.name)"
					@remove="openDeleteModal(webhook._id, webhook.name)"
				/>
			</div>
		</div>

		<!-- Create Webhook Modal -->
		<WebhooksWebhookFormModal
			:is-open="isCreateModalOpen"
			:title="t('dashboard.admin.delivery.webhooks.create')"
			:submit-label="t('dashboard.admin.delivery.webhooks.create')"
			:submitting-label="t('dashboard.admin.delivery.webhooks.creating')"
			:is-submitting="isCreating"
			:form-error="createFormError"
			:form-name="createForm.name"
			:form-url="createForm.url"
			:form-events="createForm.events"
			:show-event-actions="true"
			@close="closeCreateModal"
			@submit="handleCreate"
			@update:form-name="createForm.name = $event"
			@update:form-url="createForm.url = $event"
			@toggle-event="toggleCreateEvent"
			@select-all-events="selectAllEvents"
			@clear-all-events="clearAllEvents"
		/>

		<!-- Edit Webhook Modal -->
		<WebhooksWebhookFormModal
			:is-open="isEditModalOpen"
			:title="t('dashboard.admin.delivery.webhooks.editTitle')"
			:submit-label="t('dashboard.admin.delivery.webhooks.saveChanges')"
			:submitting-label="t('dashboard.admin.delivery.webhooks.saving')"
			:is-submitting="isEditing"
			:form-error="editFormError"
			:form-name="editForm.name"
			:form-url="editForm.url"
			:form-events="editForm.events"
			@close="closeEditModal"
			@submit="handleEdit"
			@update:form-name="editForm.name = $event"
			@update:form-url="editForm.url = $event"
			@toggle-event="toggleEditEvent"
		/>

		<!-- Secret Display, Regenerate, and Delete Modals -->
		<WebhooksWebhookDeliveryLogsModal
			:show-created-webhook="showCreatedWebhook"
			:created-webhook="createdWebhook"
			:copied-secret="copiedSecret"
			:is-regenerate-modal-open="isRegenerateModalOpen"
			:webhook-to-regenerate="webhookToRegenerate"
			:is-regenerating="isRegenerating"
			:regenerated-secret="regeneratedSecret"
			:copied-regenerated-secret="copiedRegeneratedSecret"
			:is-delete-modal-open="isDeleteModalOpen"
			:webhook-to-delete="webhookToDelete"
			:is-deleting="isDeleting"
			@close-created-webhook="closeCreatedWebhookModal"
			@copy-secret="copySecret"
			@close-regenerate="closeRegenerateModal"
			@regenerate="handleRegenerate"
			@copy-regenerated-secret="copyRegeneratedSecret"
			@close-delete="closeDeleteModal"
			@confirm-delete="handleDelete"
		/>

		<!-- Delivery Logs Panel -->
		<WebhooksWebhookDeliveryLogsPanel
			:is-open="isLogsModalOpen"
			:webhook-name="logsWebhookName"
			:webhook-id="logsWebhookId"
			:logs="deliveryLogs"
			:logs-loading="deliveryLogsLoading"
			:stats="deliveryStats"
			:selected-log-id="selectedLogId"
			:selected-log="selectedLog"
			:is-sending-test="isSendingTest"
			@close="closeLogsModal"
			@select-log="selectLog"
			@clear-selected-log="clearSelectedLog"
			@send-test="logsWebhookId && handleSendTest(logsWebhookId)"
		/>

		<!-- Unsaved Changes Dialog -->
		<UnsavedChangesDialog
			:show="showUnsavedDialog"
			@close="cancelNavigation"
			@discard="confirmDiscard"
			@save="handleGuardSave"
		/>
	</div>
</template>

