<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.team.api.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', 'admin'],
});

// Get the current user's organization
const { hasActiveOrganization, isLoading: organizationLoading } = useOrganizationContext();

// API-key management requires `organization:manage` (owner/admin). Surface a
// clean "Admins only" state for editors instead of letting the gated query's
// `forbidden` throw render as a misleading empty list. `showAdminGate` only
// asserts once the role has resolved, so an admin doesn't see a flash of the
// gated state on first paint.
const { isAdmin: canManage, showAdminGate } = usePermissions();

// Fetch API keys with real-time updates.
const { data: apiKeys, isLoading: keysLoading } = useOrganizationQuery(
	api.auth.apiKeys.listByTeam,
	{ includeRevoked: true }
);

const isLoading = computed(() => organizationLoading.value || keysLoading.value);

// Create-form error is field-bound (shown above the name input), so create
// failures surface inline instead of as a toast.
const createFormError = ref<string | null>('');

// Mutations
const { run: createKey } = useBackendOperation(api.auth.apiKeys.create, {
	label: () => t('dashboard.admin.team.api.index.operations.create'),
	inlineTarget: createFormError,
});
const { run: revokeKey } = useBackendOperation(api.auth.apiKeys.revoke, {
	label: () => t('dashboard.admin.team.api.index.operations.revoke'),
});
const { run: deleteKey } = useBackendOperation(api.auth.apiKeys.remove, {
	label: () => t('dashboard.admin.team.api.index.operations.delete'),
});
const { run: renameKey } = useBackendOperation(api.auth.apiKeys.updateName, {
	label: () => t('dashboard.admin.team.api.index.operations.rename'),
});

// Inline rename of an API key's label (the secret never changes).
const renamingId = ref<Id<'apiKeys'> | null>(null);
const renameDraft = ref('');
function startRename(id: Id<'apiKeys'>, current: string) {
	renamingId.value = id;
	renameDraft.value = current;
}
async function saveRename() {
	const id = renamingId.value;
	const name = renameDraft.value.trim();
	if (!id || !name) {
		renamingId.value = null;
		return;
	}
	await renameKey({ keyId: id, name });
	renamingId.value = null;
}

// Toast notifications (global)
const { showToast: showNotification } = useToast();

// Create API key modal
//
// Scopes are least-privilege by construction: the operator must pick at least
// one, and the key carries exactly those (the backend rejects an empty list).
// Mirrors the canonical vocabulary in apps/api/convex/auth/apiScopes.ts; the
// backend validates against it, so a drift here can only under-offer, never
// grant an unknown scope.
const AVAILABLE_SCOPES = computed<
	ReadonlyArray<{ value: string; label: string; description: string }>
>(() => [
	{
		value: 'contacts:read',
		label: t('dashboard.admin.team.api.index.scopes.contactsRead.label'),
		description: t('dashboard.admin.team.api.index.scopes.contactsRead.description'),
	},
	{
		value: 'contacts:write',
		label: t('dashboard.admin.team.api.index.scopes.contactsWrite.label'),
		description: t('dashboard.admin.team.api.index.scopes.contactsWrite.description'),
	},
	{
		value: 'events:write',
		label: t('dashboard.admin.team.api.index.scopes.eventsWrite.label'),
		description: t('dashboard.admin.team.api.index.scopes.eventsWrite.description'),
	},
	{
		value: 'transactional:send',
		label: t('dashboard.admin.team.api.index.scopes.transactionalSend.label'),
		description: t('dashboard.admin.team.api.index.scopes.transactionalSend.description'),
	},
	{
		value: 'topics:write',
		label: t('dashboard.admin.team.api.index.scopes.topicsWrite.label'),
		description: t('dashboard.admin.team.api.index.scopes.topicsWrite.description'),
	},
]);

const isCreateModalOpen = ref(false);
const createForm = reactive({
	name: '',
	scopes: [] as string[],
});
const isCreating = ref(false);

// Created key display (shown only once)
const createdKey = ref<{
	name: string;
	apiKey: string;
	keyPrefix: string;
} | null>(null);
const showCreatedKey = ref(false);
const { copy, isCopied, reset: resetCopiedKey } = useCopyToClipboard();
const CREATED_API_KEY_COPY_KEY = 'created-api-key';
const copiedKey = computed(() => isCopied(CREATED_API_KEY_COPY_KEY));

const openCreateModal = () => {
	createForm.name = '';
	createForm.scopes = [];
	createFormError.value = '';
	isCreateModalOpen.value = true;
};

const closeCreateModal = () => {
	isCreateModalOpen.value = false;
};

const handleCreate = async () => {
	if (!hasActiveOrganization.value) return;

	createFormError.value = '';

	if (!createForm.name.trim()) {
		createFormError.value = t('dashboard.admin.team.api.index.validation.nameRequired');
		return;
	}

	if (createForm.scopes.length === 0) {
		createFormError.value = t('dashboard.admin.team.api.index.validation.scopeRequired');
		return;
	}

	isCreating.value = true;

	const result = await createKey({
		name: createForm.name.trim(),
		scopes: [...createForm.scopes],
	});
	isCreating.value = false;

	if (!result) return;

	// Close create modal and show the created key
	closeCreateModal();

	// Store the created key to display
	createdKey.value = {
		name: result.name,
		apiKey: result.apiKey,
		keyPrefix: result.keyPrefix,
	};
	showCreatedKey.value = true;
	resetCopiedKey();

	showNotification(t('dashboard.admin.team.api.index.toasts.created'));
};

const closeCreatedKeyModal = () => {
	showCreatedKey.value = false;
	createdKey.value = null;
	resetCopiedKey();
};

const copyApiKey = async () => {
	if (!createdKey.value) return;

	const ok = await copy(createdKey.value.apiKey, CREATED_API_KEY_COPY_KEY);
	if (!ok) {
		showNotification(t('dashboard.admin.team.api.index.toasts.copyFailed'), 'error');
	}
};

// Revoke key modal
const isRevokeModalOpen = ref(false);
const keyToRevoke = ref<{ id: Id<'apiKeys'>; name: string } | null>(null);
const isRevoking = ref(false);

const openRevokeModal = (id: Id<'apiKeys'>, name: string) => {
	keyToRevoke.value = { id, name };
	isRevokeModalOpen.value = true;
};

const closeRevokeModal = () => {
	isRevokeModalOpen.value = false;
	keyToRevoke.value = null;
};

const handleRevoke = async () => {
	if (!keyToRevoke.value) return;

	isRevoking.value = true;
	const result = await revokeKey({ keyId: keyToRevoke.value.id });
	isRevoking.value = false;
	if (result === undefined) return;
	showNotification(t('dashboard.admin.team.api.index.toasts.revoked'));
	closeRevokeModal();
};

// Delete key modal
const isDeleteModalOpen = ref(false);
const keyToDelete = ref<{ id: Id<'apiKeys'>; name: string } | null>(null);
const isDeleting = ref(false);

const openDeleteModal = (id: Id<'apiKeys'>, name: string) => {
	keyToDelete.value = { id, name };
	isDeleteModalOpen.value = true;
};

const closeDeleteModal = () => {
	isDeleteModalOpen.value = false;
	keyToDelete.value = null;
};

const handleDelete = async () => {
	if (!keyToDelete.value) return;

	isDeleting.value = true;
	const result = await deleteKey({ keyId: keyToDelete.value.id });
	isDeleting.value = false;
	if (result === undefined) return;
	showNotification(t('dashboard.admin.team.api.index.toasts.deleted'));
	closeDeleteModal();
};

// Active keys count
const activeKeysCount = computed(() => {
	if (!apiKeys.value) return 0;
	return apiKeys.value.filter((key) => key.isActive).length;
});
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
			<div>
				<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
					{{ t('dashboard.admin.team.api.index.title') }}
				</h1>
				<p class="mt-1 text-text-secondary">{{ t('dashboard.admin.team.api.index.subtitle') }}</p>
			</div>
			<UiButton v-if="canManage" class="gap-2" @click="openCreateModal">
				<Icon name="lucide:plus" class="w-4 h-4" />
				{{ t('dashboard.admin.team.api.index.createKey') }}
			</UiButton>
		</div>

		<!-- Info Box -->
		<div class="card p-4 mb-6 bg-brand-subtle/50 border-brand/20">
			<div class="flex items-start gap-3">
				<Icon name="lucide:shield" class="w-5 h-5 text-brand shrink-0 mt-0.5" />
				<div>
					<p class="text-sm text-text-primary font-medium">{{ t('dashboard.admin.team.api.index.secureNotice.title') }}</p>
					<p class="text-sm text-text-secondary mt-1">
						{{ t('dashboard.admin.team.api.index.secureNotice.body') }}
					</p>
				</div>
			</div>
		</div>

		<!-- Rate Limiting Info -->
		<div class="card p-0 mb-6 overflow-hidden">
			<div class="px-6 py-4 border-b border-border-subtle bg-bg-surface/50">
				<div class="flex items-center gap-3">
					<Icon name="lucide:gauge" class="w-5 h-5 text-brand" />
					<h2 class="text-sm font-semibold text-text-primary">{{ t('dashboard.admin.team.api.index.rateLimit.title') }}</h2>
				</div>
			</div>
			<div class="p-6">
				<div class="grid gap-6 sm:grid-cols-2">
					<!-- Rate Limit -->
					<div class="flex items-start gap-4">
						<UiIconBox icon="lucide:gauge" size="sm" variant="brand" rounded="lg" />
						<div>
							<p class="text-sm font-medium text-text-primary">{{ t('dashboard.admin.team.api.index.rateLimit.rate') }}</p>
							<p class="text-sm text-text-secondary mt-0.5">
								{{ t('dashboard.admin.team.api.index.rateLimit.rateDescription') }}
							</p>
						</div>
					</div>

					<!-- Response Headers -->
					<div class="flex items-start gap-4">
						<UiIconBox icon="lucide:info" size="sm" variant="brand" rounded="lg" />
						<div>
							<p class="text-sm font-medium text-text-primary">
								{{ t('dashboard.admin.team.api.index.rateLimit.headersTitle') }}
							</p>
							<p class="text-sm text-text-secondary mt-0.5">
								{{ t('dashboard.admin.team.api.index.rateLimit.headersDescription') }}
							</p>
						</div>
					</div>
				</div>

				<!-- Headers Table -->
				<div class="mt-6 rounded-lg border border-border-subtle overflow-hidden">
					<table class="w-full text-sm">
						<thead>
							<tr class="bg-bg-surface">
								<th class="text-left px-4 py-2 text-text-secondary font-medium">
									{{ t('dashboard.admin.team.api.index.rateLimit.headerColumn') }}
								</th>
								<th class="text-left px-4 py-2 text-text-secondary font-medium">
									{{ t('common.description') }}
								</th>
							</tr>
						</thead>
						<tbody>
							<tr class="border-t border-border-subtle">
								<td class="px-4 py-2">
									<code
										class="text-xs font-mono text-brand bg-brand-subtle/50 px-1.5 py-0.5 rounded"
										>X-RateLimit-Limit</code
									>
								</td>
								<td class="px-4 py-2 text-text-secondary">{{ t('dashboard.admin.team.api.index.rateLimit.limitHeader') }}</td>
							</tr>
							<tr class="border-t border-border-subtle">
								<td class="px-4 py-2">
									<code
										class="text-xs font-mono text-brand bg-brand-subtle/50 px-1.5 py-0.5 rounded"
										>X-RateLimit-Remaining</code
									>
								</td>
								<td class="px-4 py-2 text-text-secondary">
									{{ t('dashboard.admin.team.api.index.rateLimit.remainingHeader') }}
								</td>
							</tr>
							<tr class="border-t border-border-subtle">
								<td class="px-4 py-2">
									<code
										class="text-xs font-mono text-brand bg-brand-subtle/50 px-1.5 py-0.5 rounded"
										>X-RateLimit-Reset</code
									>
								</td>
								<td class="px-4 py-2 text-text-secondary">
									{{ t('dashboard.admin.team.api.index.rateLimit.resetHeader') }}
								</td>
							</tr>
							<tr class="border-t border-border-subtle">
								<td class="px-4 py-2">
									<code class="text-xs font-mono text-warning bg-warning/10 px-1.5 py-0.5 rounded"
										>Retry-After</code
									>
								</td>
								<td class="px-4 py-2 text-text-secondary">
									{{ t('dashboard.admin.team.api.index.rateLimit.retryAfterHeader') }}
								</td>
							</tr>
						</tbody>
					</table>
				</div>

				<!-- Usage Example -->
				<div class="mt-4 p-4 rounded-lg bg-bg-deep border border-border-subtle">
					<p class="text-xs text-text-tertiary mb-2">{{ t('dashboard.admin.team.api.index.rateLimit.exampleHeaders') }}</p>
					<code class="text-xs font-mono text-text-secondary block leading-relaxed">
						X-RateLimit-Limit: 10<br />
						X-RateLimit-Remaining: 7<br />
						X-RateLimit-Reset: 1737158400
					</code>
				</div>
			</div>
		</div>

		<!-- API Documentation Link -->
		<div class="card p-4 mb-6 flex items-center justify-between">
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:book" size="sm" variant="surface" rounded="lg" />
				<div>
					<p class="text-sm text-text-primary font-medium">{{ t('dashboard.admin.team.api.index.docs.title') }}</p>
					<p class="text-sm text-text-tertiary">
						{{ t('dashboard.admin.team.api.index.docs.description') }}
					</p>
				</div>
			</div>
			<UiButton variant="secondary" to="/dashboard/admin/team/api/docs" class="gap-2">
				{{ t('dashboard.admin.team.api.index.docs.view') }}
				<Icon name="lucide:external-link" class="w-4 h-4" />
			</UiButton>
		</div>

		<!-- Content -->
		<div>
			<!-- Admins-only gate (editors lack organization:manage) -->
			<div
				v-if="showAdminGate"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:lock" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">{{ t('dashboard.admin.team.api.index.adminGate.title') }}</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					{{ t('dashboard.admin.team.api.index.adminGate.description') }}
				</p>
			</div>

			<!-- First-load skeleton (shaped like the API-key list) -->
			<div v-else-if="isLoading && !apiKeys" class="card overflow-hidden">
				<DashboardListSkeleton variant="card" leading :rows="4" />
			</div>

			<!-- Empty State (no organization) -->
			<div
				v-else-if="!hasActiveOrganization"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:key" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">{{ t('dashboard.admin.team.api.index.noWorkspace.title') }}</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					{{ t('dashboard.admin.team.api.index.noWorkspace.description') }}
				</p>
			</div>

			<!-- Empty State (no API keys) -->
			<div
				v-else-if="!isLoading && (!apiKeys || apiKeys.length === 0)"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:key" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">{{ t('dashboard.admin.team.api.index.empty.title') }}</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					{{ t('dashboard.admin.team.api.index.empty.description') }}
				</p>
				<UiButton class="gap-2 mt-6" @click="openCreateModal">
					<Icon name="lucide:plus" class="w-4 h-4" />
					{{ t('dashboard.admin.team.api.index.createKey') }}
				</UiButton>
			</div>

			<!-- API Keys Table -->
			<div v-else class="card p-0 overflow-hidden">
				<div class="px-6 py-4 border-b border-border-subtle">
					<h2 class="text-sm font-medium text-text-primary">
						{{ t('dashboard.admin.team.api.index.activeKeyCount', activeKeysCount) }}
					</h2>
				</div>
				<div class="overflow-x-auto">
					<table class="w-full">
						<thead>
							<tr class="border-b border-border-subtle">
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
									{{ t('common.name') }}
								</th>
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
									{{ t('dashboard.admin.team.api.index.table.key') }}
								</th>
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
									{{ t('common.status') }}
								</th>
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
									{{ t('dashboard.admin.team.api.index.table.lastUsed') }}
								</th>
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
									{{ t('dashboard.admin.team.api.index.table.created') }}
								</th>
								<th class="text-right px-6 py-4 text-sm font-medium text-text-secondary">
									{{ t('common.actions') }}
								</th>
							</tr>
						</thead>
						<tbody>
							<tr
								v-for="key in apiKeys"
								:key="key._id"
								:class="[
									'border-b border-border-subtle last:border-b-0',
									key.isActive ? 'hover:bg-bg-surface' : 'opacity-60 bg-bg-surface/50',
								]"
							>
								<td class="px-6 py-4">
									<div v-if="renamingId === key._id" class="flex items-center gap-1">
										<input
											v-model="renameDraft"
											class="input input-sm"
											:aria-label="t('dashboard.admin.team.api.index.form.nameAriaLabel')"
											@keyup.enter="saveRename"
											@keyup.esc="renamingId = null"
										/>
										<button
											class="p-1 text-success hover:bg-success/10 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
											:title="t('common.save')"
											@click="saveRename"
										>
											<Icon name="lucide:check" class="w-4 h-4" />
										</button>
										<button
											class="p-1 text-text-tertiary hover:bg-bg-surface-hover rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
											:title="t('common.cancel')"
											@click="renamingId = null"
										>
											<Icon name="lucide:x" class="w-4 h-4" />
										</button>
									</div>
									<span v-else class="text-text-primary font-medium">{{ key.name }}</span>
								</td>
								<td class="px-6 py-4">
									<code
										class="px-2 py-1 rounded bg-bg-surface text-text-secondary text-sm font-mono"
									>
										{{ key.keyPrefix }}...
									</code>
								</td>
								<td class="px-6 py-4">
									<span
										v-if="key.isActive"
										class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-success/10 text-success"
									>
										<Icon name="lucide:check" class="w-3 h-3" />
										{{ t('common.active') }}
									</span>
									<span
										v-else
										class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-error/10 text-error"
									>
										<Icon name="lucide:x" class="w-3 h-3" />
										{{ t('dashboard.admin.team.api.index.status.revoked') }}
									</span>
								</td>
								<td class="px-6 py-4">
									<span
										v-if="key.lastUsedAt"
										class="text-text-secondary text-sm flex items-center gap-1.5"
										:title="formatDateTime(key.lastUsedAt)"
									>
										<Icon name="lucide:clock" class="w-3.5 h-3.5 text-text-tertiary" />
										{{ formatCompactRelativeTime(key.lastUsedAt) }}
									</span>
									<span v-else class="text-text-tertiary text-sm">{{ t('dashboard.admin.team.api.index.neverUsed') }}</span>
								</td>
								<td class="px-6 py-4">
									<span class="text-text-tertiary text-sm">{{ formatDate(key.createdAt) }}</span>
								</td>
								<td class="px-6 py-4">
									<div class="flex items-center justify-end gap-1">
										<button
											v-if="canManage && renamingId !== key._id"
											class="p-2 rounded-lg text-text-tertiary hover:text-brand hover:bg-brand/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
											:title="t('dashboard.admin.team.api.index.actions.rename')"
											@click="startRename(key._id, key.name)"
										>
											<Icon name="lucide:pencil" class="w-4 h-4" />
										</button>
										<button
											v-if="key.isActive"
											class="p-2 rounded-lg text-text-tertiary hover:text-warning hover:bg-warning/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
											:title="t('dashboard.admin.team.api.index.actions.revoke')"
											@click="openRevokeModal(key._id, key.name)"
										>
											<Icon name="lucide:eye-off" class="w-4 h-4" />
										</button>
										<button
											class="p-2 rounded-lg text-text-tertiary hover:text-error hover:bg-error/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
											:title="t('dashboard.admin.team.api.index.actions.delete')"
											@click="openDeleteModal(key._id, key.name)"
										>
											<Icon name="lucide:trash-2" class="w-4 h-4" />
										</button>
									</div>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>
		</div>

		<!-- Create API Key Modal -->
		<UiModal
			:open="isCreateModalOpen"
			:title="t('dashboard.admin.team.api.index.createKey')"
			size="md"
			:closable="!isCreating"
			:persistent="isCreating"
			@update:open="
				(v) => {
					if (!v) closeCreateModal();
				}
			"
		>
			<!-- Form -->
			<form @submit.prevent="handleCreate">
				<!-- Error -->
				<div
					v-if="createFormError"
					class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20 flex items-start gap-3"
				>
					<Icon name="lucide:alert-circle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
					<p class="text-sm text-error">{{ createFormError }}</p>
				</div>

				<!-- Name Field -->
				<div class="mb-6">
					<label for="key-name" class="label">
						{{ t('common.name') }} <span class="text-error">*</span>
					</label>
					<input
						id="key-name"
						v-model="createForm.name"
						type="text"
						:placeholder="t('dashboard.admin.team.api.index.form.namePlaceholder')"
						class="input"
						:disabled="isCreating"
					/>
					<p class="mt-1 text-xs text-text-tertiary">
						{{ t('dashboard.admin.team.api.index.form.nameHelp') }}
					</p>
				</div>

				<!-- Scopes Field -->
				<div>
					<span class="label">{{ t('dashboard.admin.team.api.index.form.scopesLabel') }} <span class="text-error">*</span></span>
					<p class="mb-2 text-xs text-text-tertiary">
						{{ t('dashboard.admin.team.api.index.form.scopesHelp') }}
					</p>
					<div class="space-y-2">
						<label
							v-for="scope in AVAILABLE_SCOPES"
							:key="scope.value"
							class="flex items-start gap-3 p-3 rounded-lg shadow-surface-1 cursor-pointer hover:bg-bg-surface-hover"
							:class="{ 'opacity-60 cursor-not-allowed': isCreating }"
						>
							<input
								v-model="createForm.scopes"
								type="checkbox"
								:value="scope.value"
								:disabled="isCreating"
								class="mt-0.5 shrink-0"
							/>
							<span>
								<span class="block text-sm font-medium text-text-primary">{{ scope.label }}</span>
								<span class="block text-xs text-text-tertiary">{{ scope.description }}</span>
							</span>
						</label>
					</div>
				</div>
			</form>

			<template #footer>
				<UiButton
					variant="secondary"
					type="button"
					:disabled="isCreating"
					@click="closeCreateModal"
				>
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton type="button" class="gap-2" :disabled="isCreating" @click="handleCreate">
					<Icon v-if="isCreating" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
					{{ isCreating ? t('dashboard.admin.team.api.index.form.creating') : t('dashboard.admin.team.api.index.form.submit') }}
				</UiButton>
			</template>
		</UiModal>

		<!-- Created Key Display Modal -->
		<UiModal
			:open="showCreatedKey && !!createdKey"
			size="lg"
			:closable="false"
			persistent
			@update:open="
				(v) => {
					if (!v) closeCreatedKeyModal();
				}
			"
		>
			<template v-if="createdKey">
				<!-- Header -->
				<div class="flex items-center gap-3 mb-6">
					<UiIconBox icon="lucide:key" size="sm" variant="success" rounded="lg" />
					<h2 class="text-lg font-semibold text-text-primary">{{ t('dashboard.admin.team.api.index.created.title') }}</h2>
				</div>

				<!-- Content -->
				<div class="mb-4 p-4 rounded-lg bg-warning/10 border border-warning/20">
					<div class="flex items-start gap-3">
						<Icon name="lucide:alert-circle" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
						<div>
							<p class="text-sm font-medium text-warning">{{ t('dashboard.admin.team.api.index.created.copyNow') }}</p>
							<p class="text-sm text-warning/80 mt-1">
								{{ t('dashboard.admin.team.api.index.created.copyNowBody') }}
							</p>
						</div>
					</div>
				</div>

				<div class="mb-4">
					<label class="label">{{ t('common.name') }}</label>
					<p class="text-text-primary font-medium">{{ createdKey.name }}</p>
				</div>

				<div>
					<label class="label">{{ t('dashboard.admin.team.api.index.created.apiKeyLabel') }}</label>
					<div class="flex items-center gap-2">
						<code
							class="flex-1 px-4 py-3 rounded-lg bg-bg-deep text-text-primary text-sm font-mono break-all border border-border-subtle"
						>
							{{ createdKey.apiKey }}
						</code>
						<UiButton variant="secondary" class="shrink-0 gap-2" @click="copyApiKey">
							<Icon v-if="copiedKey" name="lucide:check" class="w-4 h-4 text-success" />
							<Icon v-else name="lucide:copy" class="w-4 h-4" />
							{{ copiedKey ? t('dashboard.admin.team.api.index.created.copied') : t('common.copy') }}
						</UiButton>
					</div>
				</div>
			</template>

			<template #footer>
				<UiButton @click="closeCreatedKeyModal">{{ t('common.done') }}</UiButton>
			</template>
		</UiModal>

		<!-- Revoke Key Modal -->
		<UiConfirmationDialog
			:open="isRevokeModalOpen"
			variant="warning"
			:title="t('dashboard.admin.team.api.index.revokeDialog.title')"
			:description="t('dashboard.admin.team.api.index.revokeDialog.description', { name: keyToRevoke?.name ?? '' })"
			:confirm-text="t('dashboard.admin.team.api.index.revokeDialog.confirm')"
			:is-loading="isRevoking"
			@update:open="
				(v) => {
					if (!v) closeRevokeModal();
				}
			"
			@confirm="handleRevoke"
		/>

		<!-- Delete Key Modal -->
		<UiConfirmationDialog
			:open="isDeleteModalOpen"
			variant="danger"
			:title="t('dashboard.admin.team.api.index.deleteDialog.title')"
			:description="t('dashboard.admin.team.api.index.deleteDialog.description', { name: keyToDelete?.name ?? '' })"
			:confirm-text="t('dashboard.admin.team.api.index.deleteDialog.confirm')"
			:is-loading="isDeleting"
			@update:open="
				(v) => {
					if (!v) closeDeleteModal();
				}
			"
			@confirm="handleDelete"
		/>
	</div>
</template>
