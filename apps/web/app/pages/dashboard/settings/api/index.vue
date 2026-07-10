<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'API Keys — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
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
	label: 'Create API key',
	inlineTarget: createFormError,
});
const { run: revokeKey } = useBackendOperation(api.auth.apiKeys.revoke, {
	label: 'Revoke API key',
});
const { run: deleteKey } = useBackendOperation(api.auth.apiKeys.remove, {
	label: 'Delete API key',
});
const { run: renameKey } = useBackendOperation(api.auth.apiKeys.updateName, {
	label: 'Rename API key',
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
const AVAILABLE_SCOPES: ReadonlyArray<{ value: string; label: string; description: string }> = [
	{ value: 'contacts:read', label: 'Contacts — read', description: 'List and read contacts and their details.' },
	{ value: 'contacts:write', label: 'Contacts — write', description: 'Create, update, and delete contacts.' },
	{ value: 'events:write', label: 'Events — write', description: 'Ingest events that can trigger automations.' },
	{ value: 'transactional:send', label: 'Transactional — send', description: 'Send transactional emails.' },
	{ value: 'topics:write', label: 'Topics — write', description: 'Add or remove contacts on topics.' },
];

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
		createFormError.value = 'Name is required';
		return;
	}

	if (createForm.scopes.length === 0) {
		createFormError.value = 'Select at least one scope — keys are scoped to least privilege.';
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

	showNotification('API key created successfully');
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
		showNotification('Failed to copy to clipboard', 'error');
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
	showNotification('API key revoked successfully');
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
	showNotification('API key deleted permanently');
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
				<h1 class="text-2xl font-semibold text-text-primary">API Keys</h1>
				<p class="mt-1 text-text-secondary">Manage API keys for authenticating your API requests</p>
			</div>
			<button v-if="canManage" class="btn btn-primary gap-2" @click="openCreateModal">
				<Icon name="lucide:plus" class="w-4 h-4" />
				Create API Key
			</button>
		</div>

		<!-- Info Box -->
		<div class="card p-4 mb-6 bg-brand-subtle/50 border-brand/20">
			<div class="flex items-start gap-3">
				<Icon name="lucide:shield" class="w-5 h-5 text-brand shrink-0 mt-0.5" />
				<div>
					<p class="text-sm text-text-primary font-medium">Keep your API keys secure</p>
					<p class="text-sm text-text-secondary mt-1">
						API keys grant full access to your account via the API. Never share your keys publicly
						or commit them to version control. Use environment variables to store your keys
						securely.
					</p>
				</div>
			</div>
		</div>

		<!-- Rate Limiting Info -->
		<div class="card p-0 mb-6 overflow-hidden">
			<div class="px-6 py-4 border-b border-border-subtle bg-bg-surface/50">
				<div class="flex items-center gap-3">
					<Icon name="lucide:gauge" class="w-5 h-5 text-brand" />
					<h2 class="text-sm font-semibold text-text-primary">Rate Limiting</h2>
				</div>
			</div>
			<div class="p-6">
				<div class="grid gap-6 sm:grid-cols-2">
					<!-- Rate Limit -->
					<div class="flex items-start gap-4">
						<UiIconBox icon="lucide:gauge" size="sm" variant="brand" rounded="lg" />
						<div>
							<p class="text-sm font-medium text-text-primary">10 requests/second</p>
							<p class="text-sm text-text-secondary mt-0.5">
								Maximum API calls per second per API key
							</p>
						</div>
					</div>

					<!-- Response Headers -->
					<div class="flex items-start gap-4">
						<UiIconBox icon="lucide:info" size="sm" variant="brand" rounded="lg" />
						<div>
							<p class="text-sm font-medium text-text-primary">Rate Limit Headers</p>
							<p class="text-sm text-text-secondary mt-0.5">Track usage via response headers</p>
						</div>
					</div>
				</div>

				<!-- Headers Table -->
				<div class="mt-6 rounded-lg border border-border-subtle overflow-hidden">
					<table class="w-full text-sm">
						<thead>
							<tr class="bg-bg-surface">
								<th class="text-left px-4 py-2 text-text-secondary font-medium">Header</th>
								<th class="text-left px-4 py-2 text-text-secondary font-medium">Description</th>
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
								<td class="px-4 py-2 text-text-secondary">Maximum requests per second (10)</td>
							</tr>
							<tr class="border-t border-border-subtle">
								<td class="px-4 py-2">
									<code
										class="text-xs font-mono text-brand bg-brand-subtle/50 px-1.5 py-0.5 rounded"
										>X-RateLimit-Remaining</code
									>
								</td>
								<td class="px-4 py-2 text-text-secondary">Requests remaining in current window</td>
							</tr>
							<tr class="border-t border-border-subtle">
								<td class="px-4 py-2">
									<code
										class="text-xs font-mono text-brand bg-brand-subtle/50 px-1.5 py-0.5 rounded"
										>X-RateLimit-Reset</code
									>
								</td>
								<td class="px-4 py-2 text-text-secondary">
									Unix timestamp when the rate limit resets
								</td>
							</tr>
							<tr class="border-t border-border-subtle">
								<td class="px-4 py-2">
									<code class="text-xs font-mono text-warning bg-warning/10 px-1.5 py-0.5 rounded"
										>Retry-After</code
									>
								</td>
								<td class="px-4 py-2 text-text-secondary">
									Seconds to wait when rate limited (429 response)
								</td>
							</tr>
						</tbody>
					</table>
				</div>

				<!-- Usage Example -->
				<div class="mt-4 p-4 rounded-lg bg-bg-deep border border-border-subtle">
					<p class="text-xs text-text-tertiary mb-2">Example response headers:</p>
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
					<p class="text-sm text-text-primary font-medium">API Documentation</p>
					<p class="text-sm text-text-tertiary">
						View endpoint reference, request schemas, and code examples
					</p>
				</div>
			</div>
			<NuxtLink to="/dashboard/settings/api/docs" class="btn btn-secondary gap-2">
				View Docs
				<Icon name="lucide:external-link" class="w-4 h-4" />
			</NuxtLink>
		</div>

		<!-- Content -->
		<div>
			<!-- Admins-only gate (editors lack organization:manage) -->
			<div
				v-if="showAdminGate"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:lock" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">Admins only</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					API keys can only be managed by workspace owners and admins. Ask an admin if you need
					API access.
				</p>
			</div>

			<!-- Loading State -->
			<div v-else-if="isLoading && !apiKeys" class="flex items-center justify-center py-16">
				<div class="flex flex-col items-center gap-3">
					<UiSpinner />
					<p class="text-text-secondary text-sm">Loading API keys...</p>
				</div>
			</div>

			<!-- Empty State (no organization) -->
			<div
				v-else-if="!hasActiveOrganization"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:key" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">No workspace selected</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					Create or select a workspace to manage API keys.
				</p>
			</div>

			<!-- Empty State (no API keys) -->
			<div
				v-else-if="!isLoading && (!apiKeys || apiKeys.length === 0)"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:key" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">No API keys yet</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					Create an API key to start using the API for contacts, emails, and events.
				</p>
				<button class="btn btn-primary gap-2 mt-6" @click="openCreateModal">
					<Icon name="lucide:plus" class="w-4 h-4" />
					Create API Key
				</button>
			</div>

			<!-- API Keys Table -->
			<div v-else class="card p-0 overflow-hidden">
				<div class="px-6 py-4 border-b border-border-subtle">
					<h2 class="text-sm font-medium text-text-primary">
						{{ activeKeysCount }} active {{ activeKeysCount === 1 ? 'key' : 'keys' }}
					</h2>
				</div>
				<div class="overflow-x-auto">
					<table class="w-full">
						<thead>
							<tr class="border-b border-border-subtle">
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">Name</th>
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">Key</th>
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">Status</th>
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
									Last Used
								</th>
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">Created</th>
								<th class="text-right px-6 py-4 text-sm font-medium text-text-secondary">
									Actions
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
											class="text-sm border border-border-subtle rounded px-2 py-1 bg-bg-surface text-text-primary"
											aria-label="API key name"
											@keyup.enter="saveRename"
											@keyup.esc="renamingId = null"
										>
										<button class="p-1 text-success hover:bg-success/10 rounded" title="Save" @click="saveRename">
											<Icon name="lucide:check" class="w-4 h-4" />
										</button>
										<button class="p-1 text-text-tertiary hover:bg-bg-surface rounded" title="Cancel" @click="renamingId = null">
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
										Active
									</span>
									<span
										v-else
										class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-error/10 text-error"
									>
										<Icon name="lucide:x" class="w-3 h-3" />
										Revoked
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
									<span v-else class="text-text-tertiary text-sm">Never used</span>
								</td>
								<td class="px-6 py-4">
									<span class="text-text-tertiary text-sm">{{ formatDate(key.createdAt) }}</span>
								</td>
								<td class="px-6 py-4">
									<div class="flex items-center justify-end gap-1">
										<button
											v-if="canManage && renamingId !== key._id"
											class="p-2 rounded-lg text-text-tertiary hover:text-brand hover:bg-brand/10 transition-colors"
											title="Rename Key"
											@click="startRename(key._id, key.name)"
										>
											<Icon name="lucide:pencil" class="w-4 h-4" />
										</button>
										<button
											v-if="key.isActive"
											class="p-2 rounded-lg text-text-tertiary hover:text-warning hover:bg-warning/10 transition-colors"
											title="Revoke Key"
											@click="openRevokeModal(key._id, key.name)"
										>
											<Icon name="lucide:eye-off" class="w-4 h-4" />
										</button>
										<button
											class="p-2 rounded-lg text-text-tertiary hover:text-error hover:bg-error/10 transition-colors"
											title="Delete Key"
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
			title="Create API Key"
			size="md"
			:closable="!isCreating"
			:persistent="isCreating"
			@update:open="(v) => { if (!v) closeCreateModal(); }"
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
					<label for="key-name" class="label"> Name <span class="text-error">*</span> </label>
					<input
						id="key-name"
						v-model="createForm.name"
						type="text"
						placeholder="e.g., Production, Development, CI/CD"
						class="input"
						:disabled="isCreating"
					/>
					<p class="mt-1 text-xs text-text-tertiary">
						Give your API key a descriptive name to identify its purpose.
					</p>
				</div>

				<!-- Scopes Field -->
				<div>
					<span class="label">Scopes <span class="text-error">*</span></span>
					<p class="mb-2 text-xs text-text-tertiary">
						Grant only the permissions this key needs. A compromised key can do
						nothing beyond its scopes.
					</p>
					<div class="space-y-2">
						<label
							v-for="scope in AVAILABLE_SCOPES"
							:key="scope.value"
							class="flex items-start gap-3 p-3 rounded-lg border border-border cursor-pointer hover:bg-bg-surface"
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
				<button
					type="button"
					class="btn btn-secondary"
					:disabled="isCreating"
					@click="closeCreateModal"
				>
					Cancel
				</button>
				<button type="button" class="btn btn-primary gap-2" :disabled="isCreating" @click="handleCreate">
					<Icon v-if="isCreating" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
					{{ isCreating ? 'Creating...' : 'Create Key' }}
				</button>
			</template>
		</UiModal>

		<!-- Created Key Display Modal -->
		<UiModal
			:open="showCreatedKey && !!createdKey"
			size="lg"
			:closable="false"
			persistent
			@update:open="(v) => { if (!v) closeCreatedKeyModal(); }"
		>
			<template v-if="createdKey">
				<!-- Header -->
				<div class="flex items-center gap-3 mb-6">
					<UiIconBox icon="lucide:key" size="sm" variant="success" rounded="lg" />
					<h2 class="text-lg font-semibold text-text-primary">API Key Created</h2>
				</div>

				<!-- Content -->
				<div class="mb-4 p-4 rounded-lg bg-warning/10 border border-warning/20">
					<div class="flex items-start gap-3">
						<Icon name="lucide:alert-circle" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
						<div>
							<p class="text-sm font-medium text-warning">Copy your API key now</p>
							<p class="text-sm text-warning/80 mt-1">
								This is the only time you'll see this key. Store it securely - you won't be
								able to see it again.
							</p>
						</div>
					</div>
				</div>

				<div class="mb-4">
					<label class="label">Name</label>
					<p class="text-text-primary font-medium">{{ createdKey.name }}</p>
				</div>

				<div>
					<label class="label">API Key</label>
					<div class="flex items-center gap-2">
						<code
							class="flex-1 px-4 py-3 rounded-lg bg-bg-deep text-text-primary text-sm font-mono break-all border border-border-subtle"
						>
							{{ createdKey.apiKey }}
						</code>
						<button class="btn btn-secondary shrink-0 gap-2" @click="copyApiKey">
							<Icon v-if="copiedKey" name="lucide:check" class="w-4 h-4 text-success" />
							<Icon v-else name="lucide:copy" class="w-4 h-4" />
							{{ copiedKey ? 'Copied!' : 'Copy' }}
						</button>
					</div>
				</div>
			</template>

			<template #footer>
				<button class="btn btn-primary" @click="closeCreatedKeyModal">Done</button>
			</template>
		</UiModal>

		<!-- Revoke Key Modal -->
		<UiConfirmationDialog
			:open="isRevokeModalOpen"
			variant="warning"
			title="Revoke API Key"
			:description="`Revoking &quot;${keyToRevoke?.name ?? ''}&quot; will immediately disable the key. Any API requests using this key will fail. You can delete the key later to remove it completely.`"
			confirm-text="Revoke Key"
			:is-loading="isRevoking"
			@update:open="(v) => { if (!v) closeRevokeModal(); }"
			@confirm="handleRevoke"
		/>

		<!-- Delete Key Modal -->
		<UiConfirmationDialog
			:open="isDeleteModalOpen"
			variant="danger"
			title="Delete API Key"
			:description="`Permanently delete &quot;${keyToDelete?.name ?? ''}&quot;? This action cannot be undone. The key will be permanently removed from your account.`"
			confirm-text="Delete Key"
			:is-loading="isDeleting"
			@update:open="(v) => { if (!v) closeDeleteModal(); }"
			@confirm="handleDelete"
		/>
	</div>
</template>
