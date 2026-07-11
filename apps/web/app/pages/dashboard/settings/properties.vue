<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Contact Properties — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Get the current user's organization
const { hasActiveOrganization, isLoading: teamLoading } = useOrganizationContext();

// Get contact properties with real-time updates
const {
	data: propertiesData,
	isLoading: propertiesLoading,
	error: propertiesError,
} = useOrganizationQuery(api.contacts.properties.listByOrganization);

const isLoading = computed(() => teamLoading.value || propertiesLoading.value);

// Mutations
const { run: createProperty } = useBackendOperation(api.contacts.properties.create, {
	label: 'Create property',
});
const { run: updateProperty } = useBackendOperation(api.contacts.properties.update, {
	label: 'Update property',
});
const { run: removeProperty } = useBackendOperation(api.contacts.properties.remove, {
	label: 'Delete property',
});

// Convex client for one-time queries
const convex = useConvex();

// Create modal state (shared form-modal primitive)
const {
	isOpen: isCreateModalOpen,
	isSubmitting: isCreating,
	form: createForm,
	errors: createFormErrors,
	open: openCreateModal,
	close: closeCreateModal,
	clearErrors: clearCreateErrors,
} = useFormModal({
	key: '',
	label: '',
	type: 'string' as 'string' | 'number' | 'boolean' | 'date',
});

// Edit modal state
const isEditModalOpen = ref(false);
const editingProperty = ref<{
	_id: Id<'contactProperties'>;
	key: string;
	label: string;
	type: 'string' | 'number' | 'boolean' | 'date';
} | null>(null);
const editForm = reactive({
	label: '',
});
const editFormErrors = reactive({
	label: '',
});
const isEditing = ref(false);

// Delete modal state
const propertyToDelete = ref<{
	_id: Id<'contactProperties'>;
	key: string;
	label: string;
} | null>(null);
const deletePropertyUsageCount = ref(0);
const isDeleting = ref(false);
const isLoadingUsageCount = ref(false);

// Dropdown state
const openDropdown = ref<Id<'contactProperties'> | null>(null);

// Toast notification using global composable
const { showToast } = useToast();

// Property types with icons and labels
const propertyTypes = [
	{ value: 'string', label: 'Text', icon: 'lucide:type', description: 'Single line text' },
	{ value: 'number', label: 'Number', icon: 'lucide:hash', description: 'Numeric values' },
	{ value: 'boolean', label: 'Boolean', icon: 'lucide:toggle-left', description: 'True or false' },
	{ value: 'date', label: 'Date', icon: 'lucide:calendar', description: 'Date values' },
] as const;

// Get type info
const getTypeInfo = (type: string) => {
	return propertyTypes.find((t) => t.value === type) || propertyTypes[0];
};

// Generate key from label
const generateKey = (label: string) => {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, '')
		.replace(/\s+/g, '_')
		.substring(0, 50);
};

// Watch label to auto-generate key (only in create mode)
watch(
	() => createForm.label,
	(newLabel) => {
		if (!createForm.key || createForm.key === generateKey(createForm.label.slice(0, -1))) {
			createForm.key = generateKey(newLabel);
		}
	}
);

// Validate create form
const validateCreateForm = (): boolean => {
	clearCreateErrors();
	let isValid = true;

	if (!createForm.label.trim()) {
		createFormErrors.label = 'Label is required';
		isValid = false;
	}

	if (!createForm.key.trim()) {
		createFormErrors.key = 'Key is required';
		isValid = false;
	} else if (!/^[a-z0-9_]+$/.test(createForm.key)) {
		createFormErrors.key = 'Key must contain only lowercase letters, numbers, and underscores';
		isValid = false;
	}

	return isValid;
};

// Validate edit form
const validateEditForm = (): boolean => {
	editFormErrors.label = '';

	if (!editForm.label.trim()) {
		editFormErrors.label = 'Label is required';
		return false;
	}

	return true;
};

// Handle create
const handleCreate = async () => {
	if (!hasActiveOrganization.value) return;
	if (!validateCreateForm()) return;

	isCreating.value = true;

	const result = await createProperty({
		key: createForm.key.trim(),
		label: createForm.label.trim(),
		type: createForm.type,
	});
	isCreating.value = false;

	if (result === undefined) return;

	showToast(`Property "${createForm.label}" created`);
	closeCreateModal();
};

// Handle edit
const handleEdit = async () => {
	if (!editingProperty.value) return;
	if (!validateEditForm()) return;

	isEditing.value = true;

	const result = await updateProperty({
		propertyId: editingProperty.value._id,
		label: editForm.label.trim(),
	});
	isEditing.value = false;

	if (result === undefined) return;

	showToast('Property updated');
	isEditModalOpen.value = false;
	editingProperty.value = null;
};

// Open edit modal
const openEditModal = (property: NonNullable<typeof propertiesData.value>[number]) => {
	editingProperty.value = {
		_id: property._id,
		key: property.key,
		label: property.label,
		type: property.type,
	};
	editForm.label = property.label;
	editFormErrors.label = '';
	isEditModalOpen.value = true;
	openDropdown.value = null;
};

// Open delete modal
const openDeleteModal = async (property: NonNullable<typeof propertiesData.value>[number]) => {
	propertyToDelete.value = {
		_id: property._id,
		key: property.key,
		label: property.label,
	};
	openDropdown.value = null;

	// Load usage count
	isLoadingUsageCount.value = true;
	try {
		if (convex) {
			const count = await convex.query(api.contacts.propertyValues.countByProperty, {
				propertyId: property._id,
			});
			deletePropertyUsageCount.value = count;
		}
	} catch {
		deletePropertyUsageCount.value = 0;
	} finally {
		isLoadingUsageCount.value = false;
	}
};

// Handle delete
const handleDelete = async () => {
	if (!propertyToDelete.value) return;

	isDeleting.value = true;

	const result = await removeProperty({
		propertyId: propertyToDelete.value._id,
	});
	isDeleting.value = false;

	if (result === undefined) return;

	showToast(`Property "${propertyToDelete.value.label}" deleted`);
	propertyToDelete.value = null;
};

// Close dropdown on click outside
useClickOutsideSelector('[data-property-dropdown]', () => {
	openDropdown.value = null;
});
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6">
			<NuxtLink
				to="/dashboard/settings"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Back to Settings
			</NuxtLink>
			<div class="flex items-center justify-between">
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">Contact Properties</h1>
					<p class="mt-1 text-text-secondary">Create and manage custom fields for your contacts</p>
				</div>
				<UiButton @click="openCreateModal()">
					<template #iconLeft>
						<Icon name="lucide:plus" class="w-4 h-4" />
					</template>
					New Property
				</UiButton>
			</div>
		</div>

		<UiQueryBoundary
			:loading="isLoading && !propertiesData"
			:error="propertiesError"
			error-title="Couldn't load properties"
		>
			<template #loading>
				<div class="flex items-center justify-center py-16">
					<div class="flex flex-col items-center gap-3">
						<UiSpinner />
						<p class="text-text-secondary text-sm">Loading properties...</p>
					</div>
				</div>
			</template>

			<!-- No Team State -->
			<UiCard v-if="!hasActiveOrganization">
				<UiEmptyState
					icon="lucide:tags"
					title="No team selected"
					description="Create or select a team to manage contact properties."
				/>
			</UiCard>

			<!-- Content -->
			<div v-else class="space-y-6">
				<!-- Properties List -->
				<UiCard padding="none" overflow="hidden">
					<template #header>
						<div class="flex items-center gap-3">
							<UiIconBox icon="lucide:tags" size="sm" variant="surface" rounded="lg" />
							<div>
								<h2 class="text-lg font-semibold text-text-primary">Properties</h2>
								<p class="text-sm text-text-secondary">
									{{ propertiesData?.length || 0 }} custom field{{
										(propertiesData?.length || 0) !== 1 ? 's' : ''
									}}
								</p>
							</div>
						</div>
					</template>

					<!-- Empty State -->
					<UiEmptyState
						v-if="!propertiesData || propertiesData.length === 0"
						icon="lucide:tags"
						title="No properties yet"
						description="Create custom properties to store additional information about your contacts."
						class="py-12"
					>
						<template #action>
							<UiButton @click="openCreateModal()">
								<template #iconLeft>
									<Icon name="lucide:plus" class="w-4 h-4" />
								</template>
								Create First Property
							</UiButton>
						</template>
					</UiEmptyState>

					<!-- Properties Table -->
					<div v-else class="divide-y divide-border-subtle">
						<div
							v-for="property in propertiesData"
							:key="property._id"
							class="px-6 py-4 flex items-center justify-between hover:bg-bg-surface/50 transition-colors"
						>
							<div class="flex items-center gap-4">
								<!-- Type Icon -->
								<div class="p-2 rounded-lg bg-bg-surface flex items-center justify-center">
									<Icon
										:name="getTypeInfo(property.type).icon"
										class="w-5 h-5 text-text-secondary"
									/>
								</div>

								<!-- Property Info -->
								<div>
									<div class="flex items-center gap-2">
										<p class="font-medium text-text-primary">{{ property.label }}</p>
										<span
											class="px-2 py-0.5 rounded-full text-xs font-medium bg-bg-surface text-text-secondary border border-border-subtle"
										>
											{{ getTypeInfo(property.type).label }}
										</span>
									</div>
									<p class="text-sm text-text-tertiary font-mono">{{ property.key }}</p>
								</div>
							</div>

							<!-- Actions -->
							<div class="relative" data-property-dropdown>
								<UiButton
									variant="ghost"
									size="sm"
									@click.stop="openDropdown = openDropdown === property._id ? null : property._id"
								>
									<Icon name="lucide:more-horizontal" class="w-4 h-4" />
								</UiButton>

								<!-- Dropdown Menu -->
								<Transition name="dropdown">
									<div
										v-if="openDropdown === property._id"
										class="absolute right-0 mt-2 w-40 bg-bg-elevated border border-border-subtle rounded-xl shadow-lg z-10 py-1"
									>
										<button
											class="w-full px-4 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2"
											@click="openEditModal(property)"
										>
											<Icon name="lucide:pencil" class="w-4 h-4 text-text-tertiary" />
											Edit
										</button>
										<button
											class="w-full px-4 py-2 text-left text-sm text-error hover:bg-bg-surface flex items-center gap-2"
											@click="openDeleteModal(property)"
										>
											<Icon name="lucide:trash-2" class="w-4 h-4" />
											Delete
										</button>
									</div>
								</Transition>
							</div>
						</div>
					</div>
				</UiCard>

				<!-- Info Card -->
				<UiCard>
					<h3 class="text-sm font-medium text-text-primary mb-4">Property Types</h3>
					<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
						<div v-for="type in propertyTypes" :key="type.value" class="flex items-start gap-3">
							<div class="p-2 rounded-lg bg-bg-surface flex items-center justify-center">
								<Icon :name="type.icon" class="w-4 h-4 text-text-secondary" />
							</div>
							<div>
								<p class="font-medium text-text-primary text-sm">{{ type.label }}</p>
								<p class="text-xs text-text-secondary mt-0.5">{{ type.description }}</p>
							</div>
						</div>
					</div>
				</UiCard>
			</div>
		</UiQueryBoundary>

		<!-- Create Property Modal -->
		<UiModal v-model:open="isCreateModalOpen" title="New Property">
			<form @submit.prevent="handleCreate">
				<div class="space-y-4">
					<!-- Label -->
					<UiInput
						v-model="createForm.label"
						label="Label"
						placeholder="e.g., Company Name"
						:error="createFormErrors.label"
						:disabled="isCreating"
						:required="true"
						:help-text="
							!createFormErrors.label
								? 'Display name shown in forms and contact details.'
								: undefined
						"
					/>

					<!-- Key -->
					<div>
						<UiInput
							v-model="createForm.key"
							label="Key"
							placeholder="e.g., company_name"
							:error="createFormErrors.key"
							:disabled="isCreating"
							:required="true"
						/>
						<p v-if="!createFormErrors.key" class="mt-1 text-xs text-text-tertiary">
							Used in API and email templates as
							<code class="px-1 py-0.5 rounded bg-bg-surface text-text-primary"
								>&#123;&#123;{{ createForm.key || 'key' }}&#125;&#125;</code
							>
						</p>
					</div>

					<!-- Type -->
					<div>
						<label class="label">Type</label>
						<div class="grid grid-cols-2 gap-3">
							<button
								v-for="type in propertyTypes"
								:key="type.value"
								type="button"
								:class="[
									'p-3 rounded-xl border text-left transition-all',
									createForm.type === type.value
										? 'border-brand bg-brand/10'
										: 'border-border-subtle hover:border-border-default',
								]"
								:disabled="isCreating"
								@click="createForm.type = type.value"
							>
								<div class="flex items-center gap-2 mb-1">
									<Icon :name="type.icon" class="w-4 h-4 text-text-secondary" />
									<span class="font-medium text-text-primary text-sm">{{ type.label }}</span>
								</div>
								<p class="text-xs text-text-secondary">{{ type.description }}</p>
							</button>
						</div>
					</div>
				</div>
			</form>

			<template #footer>
				<UiButton variant="secondary" :disabled="isCreating" @click="closeCreateModal()">
					Cancel
				</UiButton>
				<UiButton :loading="isCreating" @click="handleCreate">
					<template #iconLeft>
						<Icon v-if="!isCreating" name="lucide:plus" class="w-4 h-4" />
					</template>
					{{ isCreating ? 'Creating...' : 'Create Property' }}
				</UiButton>
			</template>
		</UiModal>

		<!-- Edit Property Modal -->
		<UiModal v-model:open="isEditModalOpen" title="Edit Property">
			<div class="space-y-4">
				<!-- Property Info (Read-only) -->
				<div
					v-if="editingProperty"
					class="p-4 rounded-xl bg-bg-surface border border-border-subtle"
				>
					<div class="flex items-center gap-3">
						<div class="p-2 rounded-lg bg-bg-elevated flex items-center justify-center">
							<Icon
								:name="getTypeInfo(editingProperty.type).icon"
								class="w-5 h-5 text-text-secondary"
							/>
						</div>
						<div>
							<p class="text-sm text-text-tertiary">Key</p>
							<p class="font-mono text-text-primary">{{ editingProperty.key }}</p>
						</div>
					</div>
					<p class="mt-3 text-xs text-text-tertiary">
						Key and type cannot be changed after creation.
					</p>
				</div>

				<!-- Label -->
				<UiInput
					v-model="editForm.label"
					label="Label"
					placeholder="e.g., Company Name"
					:error="editFormErrors.label"
					:disabled="isEditing"
					:required="true"
				/>
			</div>

			<template #footer>
				<UiButton variant="secondary" :disabled="isEditing" @click="isEditModalOpen = false">
					Cancel
				</UiButton>
				<UiButton :loading="isEditing" @click="handleEdit">
					<template #iconLeft>
						<Icon v-if="!isEditing" name="lucide:check" class="w-4 h-4" />
					</template>
					{{ isEditing ? 'Saving...' : 'Save Changes' }}
				</UiButton>
			</template>
		</UiModal>

		<!-- Delete Property Modal -->
		<UiModal
			:open="!!propertyToDelete"
			title="Delete Property"
			@update:open="(v: boolean) => !v && (propertyToDelete = null)"
		>
			<p class="text-text-secondary">
				Are you sure you want to delete the property
				<span v-if="propertyToDelete" class="font-medium text-text-primary"
					>"{{ propertyToDelete.label }}"</span
				>?
			</p>

			<!-- Warning about data -->
			<div
				v-if="isLoadingUsageCount"
				class="mt-4 p-4 rounded-xl bg-bg-surface border border-border-subtle flex items-center gap-3"
			>
				<Icon name="lucide:loader-2" class="w-4 h-4 animate-spin text-text-tertiary" />
				<span class="text-sm text-text-tertiary">Checking usage...</span>
			</div>
			<div
				v-else-if="deletePropertyUsageCount > 0"
				class="mt-4 p-4 rounded-xl bg-warning-subtle border border-warning/20"
			>
				<div class="flex items-start gap-3">
					<Icon name="lucide:alert-circle" class="w-5 h-5 text-warning mt-0.5 flex-shrink-0" />
					<div>
						<p class="font-medium text-warning">Data will be deleted</p>
						<p class="text-sm text-warning/80 mt-1">
							{{ deletePropertyUsageCount }} contact{{
								deletePropertyUsageCount !== 1 ? 's have' : ' has'
							}}
							values for this property. All values will be permanently deleted.
						</p>
					</div>
				</div>
			</div>

			<template #footer>
				<UiButton variant="secondary" :disabled="isDeleting" @click="propertyToDelete = null">
					Cancel
				</UiButton>
				<UiButton
					variant="danger"
					:loading="isDeleting"
					:disabled="isLoadingUsageCount"
					@click="handleDelete"
				>
					<template #iconLeft>
						<Icon v-if="!isDeleting" name="lucide:trash-2" class="w-4 h-4" />
					</template>
					{{ isDeleting ? 'Deleting...' : 'Delete Property' }}
				</UiButton>
			</template>
		</UiModal>
	</div>
</template>

<style scoped>
/* Dropdown transition */
.dropdown-enter-active,
.dropdown-leave-active {
	transition: all var(--motion-fast) var(--ease-spring);
}

.dropdown-enter-from,
.dropdown-leave-to {
	opacity: 0;
	transform: translateY(-0.5rem);
}
</style>
