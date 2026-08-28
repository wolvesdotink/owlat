<script setup lang="ts">
import { api } from '@owlat/api';

const { t } = useI18n();

/**
 * `getEventLabel` reads a module-scope definition set whose labels carry i18n
 * keys rather than sentences (the registry convention); a plain string is still
 * accepted so a value with nothing to translate reads as itself.
 */
type LocalizedText = string | { key: string; params?: Record<string, unknown> };
function localized(value: LocalizedText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}

useHead({ title: () => t('dashboard.admin.delivery.webhooks.pageTitle') });

definePageMeta({
	layout: 'dashboard',
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
	formatDate,
	getEventLabel,
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

			<!-- Empty State (no organization) -->
			<div
				v-else-if="!hasActiveOrganization"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:webhook" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">
					{{ t('dashboard.admin.delivery.webhooks.noWorkspace.title') }}
				</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					{{ t('dashboard.admin.delivery.webhooks.noWorkspace.description') }}
				</p>
			</div>

			<!-- Empty State (no webhooks) -->
			<div
				v-else-if="!isLoading && (!webhooks || webhooks.length === 0)"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:webhook" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">
					{{ t('dashboard.admin.delivery.webhooks.empty.title') }}
				</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					{{ t('dashboard.admin.delivery.webhooks.empty.description') }}
				</p>
				<UiButton class="gap-2 mt-6" @click="openCreateModal">
					<Icon name="lucide:plus" class="w-4 h-4" />
					{{ t('dashboard.admin.delivery.webhooks.create') }}
				</UiButton>
			</div>

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

				<div
					v-for="webhook in webhooks"
					:key="webhook._id"
					:class="['card p-0 overflow-hidden', webhook.isActive ? '' : 'opacity-60']"
				>
					<!-- Webhook Header -->
					<div
						class="flex items-center justify-between px-6 py-4 cursor-pointer hover:bg-bg-surface/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
						role="button"
						tabindex="0"
						:aria-expanded="expandedWebhookId === webhook._id"
						:aria-controls="`webhook-details-${webhook._id}`"
						:aria-label="t('dashboard.admin.delivery.webhooks.detailsFor', { name: webhook.name })"
						@click="toggleExpanded(webhook._id)"
						@keydown.enter.self="toggleExpanded(webhook._id)"
						@keydown.space.self.prevent="toggleExpanded(webhook._id)"
					>
						<div class="flex items-center gap-4 min-w-0">
							<div
								:class="[
									'p-2 rounded-lg shrink-0',
									webhook.isActive ? 'bg-success/10' : 'bg-bg-surface',
								]"
							>
								<Icon
									name="lucide:globe"
									:class="['w-5 h-5', webhook.isActive ? 'text-success' : 'text-text-tertiary']"
								/>
							</div>
							<div class="min-w-0">
								<div class="flex items-center gap-3">
									<span class="text-text-primary font-medium">{{ webhook.name }}</span>
									<span
										:class="[
											'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium',
											webhook.isActive
												? 'bg-success/10 text-success'
												: 'bg-bg-surface text-text-tertiary',
										]"
									>
										{{
											webhook.isActive
												? t('common.active')
												: t('dashboard.admin.delivery.webhooks.disabled')
										}}
									</span>
								</div>
								<p class="text-sm text-text-tertiary truncate mt-0.5">
									{{ webhook.url }}
								</p>
							</div>
						</div>
						<div class="flex items-center gap-2">
							<Icon
								name="lucide:chevron-down"
								:class="[
									'w-5 h-5 text-text-tertiary transition-transform',
									expandedWebhookId === webhook._id ? 'rotate-180' : '',
								]"
							/>
						</div>
					</div>

					<!-- Expanded Details -->
					<Transition name="expand">
						<div
							v-if="expandedWebhookId === webhook._id"
							:id="`webhook-details-${webhook._id}`"
							class="border-t border-border-subtle"
						>
							<!-- Events -->
							<div class="px-6 py-4 border-b border-border-subtle">
								<p class="text-sm font-medium text-text-secondary mb-2">
									{{ t('dashboard.admin.delivery.webhooks.subscribedEvents') }}
								</p>
								<div class="flex flex-wrap gap-2">
									<span
										v-for="event in webhook.events"
										:key="event"
										class="inline-flex items-center px-2.5 py-1 rounded text-xs font-medium bg-bg-surface text-text-primary"
									>
										{{ localized(getEventLabel(event)) }}
									</span>
								</div>
							</div>

							<!-- Info -->
							<div class="px-6 py-4 border-b border-border-subtle grid grid-cols-2 gap-4">
								<div>
									<p class="text-xs text-text-tertiary">
										{{ t('dashboard.admin.delivery.webhooks.created') }}
									</p>
									<p class="text-sm text-text-secondary">{{ formatDate(webhook.createdAt) }}</p>
								</div>
								<div>
									<p class="text-xs text-text-tertiary">
										{{ t('dashboard.admin.delivery.webhooks.lastUpdated') }}
									</p>
									<p class="text-sm text-text-secondary">{{ formatDate(webhook.updatedAt) }}</p>
								</div>
							</div>

							<!-- Actions -->
							<div class="px-6 py-4 flex items-center justify-between">
								<div class="flex items-center gap-2">
									<UiButton
										variant="secondary"
										class="gap-2"
										:disabled="togglingWebhookId === webhook._id"
										@click.stop="handleToggle(webhook._id)"
									>
										<Icon
											v-if="togglingWebhookId === webhook._id"
											name="lucide:loader-2"
											class="w-4 h-4 animate-spin motion-reduce:animate-none"
										/>
										<Icon v-else-if="!webhook.isActive" name="lucide:play" class="w-4 h-4" />
										<Icon v-else name="lucide:pause" class="w-4 h-4" />
										{{
											webhook.isActive
												? t('dashboard.admin.delivery.webhooks.disable')
												: t('dashboard.admin.delivery.webhooks.enable')
										}}
									</UiButton>
									<UiButton variant="secondary" class="gap-2" @click.stop="openEditModal(webhook)">
										<Icon name="lucide:settings" class="w-4 h-4" />
										{{ t('common.edit') }}
									</UiButton>
									<UiButton
										variant="secondary"
										class="gap-2"
										:disabled="!webhook.isActive || isSendingTest"
										@click.stop="handleSendTest(webhook._id)"
									>
										<Icon
											v-if="isSendingTest"
											name="lucide:loader-2"
											class="w-4 h-4 animate-spin motion-reduce:animate-none"
										/>
										<Icon v-else name="lucide:send" class="w-4 h-4" />
										{{ t('dashboard.admin.delivery.webhooks.sendTest') }}
									</UiButton>
									<UiButton
										variant="secondary"
										class="gap-2"
										@click.stop="openLogsModal(webhook._id, webhook.name)"
									>
										<Icon name="lucide:scroll-text" class="w-4 h-4" />
										{{ t('dashboard.admin.delivery.webhooks.deliveryLogs') }}
									</UiButton>
									<UiButton
										variant="secondary"
										class="gap-2"
										@click.stop="openRegenerateModal(webhook._id, webhook.name)"
									>
										<Icon name="lucide:refresh-cw" class="w-4 h-4" />
										{{ t('dashboard.admin.delivery.webhooks.regenerateSecret') }}
									</UiButton>
								</div>
								<UiButton
									variant="ghost"
									class="text-error hover:bg-error/10 gap-2"
									@click.stop="openDeleteModal(webhook._id, webhook.name)"
								>
									<Icon name="lucide:trash-2" class="w-4 h-4" />
									{{ t('common.delete') }}
								</UiButton>
							</div>
						</div>
					</Transition>
				</div>
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
	</div>
</template>

<style scoped>
/* Expand transition */
.expand-enter-active,
.expand-leave-active {
	transition: all var(--motion-moderate) var(--ease-spring);
	overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
	opacity: 0;
	max-height: 0;
}

.expand-enter-to,
.expand-leave-from {
	max-height: 600px;
}
</style>
