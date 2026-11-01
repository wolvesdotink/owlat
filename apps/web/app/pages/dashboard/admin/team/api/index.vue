<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import ApiKeysCreatedKeyModal from '~/components/apiKeys/CreatedKeyModal.vue';
import ApiKeysCreateKeyModal from '~/components/apiKeys/CreateKeyModal.vue';
import ApiKeysTable from '~/components/apiKeys/KeysTable.vue';
import ApiKeysRateLimitInfo from '~/components/apiKeys/RateLimitInfo.vue';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.team.api.index.pageTitle') });

definePageMeta({
	layout: 'admin',
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
const {
	data: apiKeys,
	isLoading: keysLoading,
	error: keysError,
	refetch: refetchKeys,
} = useOrganizationQuery(api.auth.apiKeys.listByTeam, { includeRevoked: true });

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

// Create API key modal (the scope list lives in the modal)
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

	if (!result.ok) return;

	// Close create modal and show the created key
	closeCreateModal();

	// Store the created key to display
	createdKey.value = {
		name: result.result.name,
		apiKey: result.result.apiKey,
		keyPrefix: result.result.keyPrefix,
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
	if (!result.ok) return;
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
	if (!result.ok) return;
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
	<div>
		<!-- UiPageHeader's actions region carries `data-testid="page-header-actions"`:
		     the empty state below offers a button with the identical label, so the
		     pair is only tellable apart by region. -->
		<UiPageHeader
			class="mb-6"
			:title="t('dashboard.admin.team.api.index.title')"
			:description="t('dashboard.admin.team.api.index.subtitle')"
		>
			<template v-if="canManage" #actions>
				<UiButton class="gap-2" @click="openCreateModal">
					<Icon name="lucide:plus" class="w-4 h-4" />
					{{ t('dashboard.admin.team.api.index.createKey') }}
				</UiButton>
			</template>
		</UiPageHeader>

		<!-- Info Box -->
		<div class="card p-4 mb-6 bg-brand-subtle/50 border-brand/20">
			<div class="flex items-start gap-3">
				<Icon name="lucide:shield" class="w-5 h-5 text-brand shrink-0 mt-0.5" />
				<div>
					<p class="text-sm text-text-primary font-medium">
						{{ t('dashboard.admin.team.api.index.secureNotice.title') }}
					</p>
					<p class="text-sm text-text-secondary mt-1">
						{{ t('dashboard.admin.team.api.index.secureNotice.body') }}
					</p>
				</div>
			</div>
		</div>

		<!-- The keys lead: they are what this page manages. The rate-limit and
		     docs reference used to sit above them, pushing the list below the fold. -->
		<div class="mb-6">
			<!-- Admins-only gate (editors lack organization:manage) -->
			<div
				v-if="showAdminGate"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:lock" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">
					{{ t('dashboard.admin.team.api.index.adminGate.title') }}
				</p>
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
				<p class="text-text-secondary font-medium">
					{{ t('dashboard.admin.team.api.index.noWorkspace.title') }}
				</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					{{ t('dashboard.admin.team.api.index.noWorkspace.description') }}
				</p>
			</div>

			<!-- A failed read is not an empty list (#721). -->
			<UiQueryBoundary v-else-if="keysError" :error="keysError" @retry="refetchKeys" />

			<!-- Empty State (no API keys) -->
			<div
				v-else-if="!isLoading && (!apiKeys || apiKeys.length === 0)"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:key" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">
					{{ t('dashboard.admin.team.api.index.empty.title') }}
				</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					{{ t('dashboard.admin.team.api.index.empty.description') }}
				</p>
				<UiButton class="gap-2 mt-6" @click="openCreateModal">
					<Icon name="lucide:plus" class="w-4 h-4" />
					{{ t('dashboard.admin.team.api.index.createKey') }}
				</UiButton>
			</div>

			<!-- API Keys Table -->
			<ApiKeysTable
				v-else
				v-model:rename-draft="renameDraft"
				:api-keys="apiKeys ?? []"
				:active-keys-count="activeKeysCount"
				:can-manage="canManage"
				:renaming-id="renamingId"
				@start-rename="startRename"
				@save-rename="saveRename"
				@cancel-rename="renamingId = null"
				@revoke="openRevokeModal"
				@delete="openDeleteModal"
			/>
		</div>

		<!-- API Documentation Link -->
		<div
			class="card p-4 mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
		>
			<div class="flex min-w-0 items-center gap-3">
				<UiIconBox icon="lucide:book" size="sm" variant="surface" rounded="lg" />
				<div>
					<p class="text-sm text-text-primary font-medium">
						{{ t('dashboard.admin.team.api.index.docs.title') }}
					</p>
					<p class="text-sm text-text-tertiary">
						{{ t('dashboard.admin.team.api.index.docs.description') }}
					</p>
				</div>
			</div>
			<UiButton
				variant="secondary"
				to="/dashboard/admin/team/api/docs"
				class="shrink-0 gap-2 self-start whitespace-nowrap sm:self-auto"
			>
				{{ t('dashboard.admin.team.api.index.docs.view') }}
				<Icon name="lucide:external-link" class="w-4 h-4" />
			</UiButton>
		</div>

		<!-- Rate Limiting Info -->
		<ApiKeysRateLimitInfo />

		<!-- Create API Key Modal -->
		<ApiKeysCreateKeyModal
			:open="isCreateModalOpen"
			:is-creating="isCreating"
			:error="createFormError"
			:form="createForm"
			@close="closeCreateModal"
			@submit="handleCreate"
		/>

		<!-- Created Key Display Modal -->
		<ApiKeysCreatedKeyModal
			:open="showCreatedKey && !!createdKey"
			:created-key="createdKey"
			:copied="copiedKey"
			@close="closeCreatedKeyModal"
			@copy="copyApiKey"
		/>

		<!-- Revoke Key Modal -->
		<UiConfirmationDialog
			:open="isRevokeModalOpen"
			variant="warning"
			:title="t('dashboard.admin.team.api.index.revokeDialog.title')"
			:description="
				t('dashboard.admin.team.api.index.revokeDialog.description', {
					name: keyToRevoke?.name ?? '',
				})
			"
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
			:description="
				t('dashboard.admin.team.api.index.deleteDialog.description', {
					name: keyToDelete?.name ?? '',
				})
			"
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
