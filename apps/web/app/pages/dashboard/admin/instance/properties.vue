<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.instance.properties.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', 'admin'],
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
	label: () => t('dashboard.admin.instance.properties.operations.create'),
});
const { run: updateProperty } = useBackendOperation(api.contacts.properties.update, {
	label: () => t('dashboard.admin.instance.properties.operations.update'),
});
const { run: removeProperty } = useBackendOperation(api.contacts.properties.remove, {
	label: () => t('dashboard.admin.instance.properties.operations.remove'),
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

/**
 * Property types with icons and labels. `label` / `description` hold MESSAGE
 * KEYS, not words: the table is module scope (it types `createForm.type`), so it
 * never calls `useI18n` — the template below is the render boundary that turns
 * each key into words.
 */
const propertyTypes = [
	{
		value: 'string',
		label: 'dashboard.admin.instance.properties.types.string.label',
		icon: 'lucide:type',
		description: 'dashboard.admin.instance.properties.types.string.description',
	},
	{
		value: 'number',
		label: 'dashboard.admin.instance.properties.types.number.label',
		icon: 'lucide:hash',
		description: 'dashboard.admin.instance.properties.types.number.description',
	},
	{
		value: 'boolean',
		label: 'dashboard.admin.instance.properties.types.boolean.label',
		icon: 'lucide:toggle-left',
		description: 'dashboard.admin.instance.properties.types.boolean.description',
	},
	{
		value: 'date',
		label: 'dashboard.admin.instance.properties.types.date.label',
		icon: 'lucide:calendar',
		description: 'dashboard.admin.instance.properties.types.date.description',
	},
] as const;

// Get type info
const getTypeInfo = (type: string) => {
	return propertyTypes.find((entry) => entry.value === type) || propertyTypes[0];
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
		createFormErrors.label = t('dashboard.admin.instance.properties.errors.labelRequired');
		isValid = false;
	}

	if (!createForm.key.trim()) {
		createFormErrors.key = t('dashboard.admin.instance.properties.errors.keyRequired');
		isValid = false;
	} else if (!/^[a-z0-9_]+$/.test(createForm.key)) {
		createFormErrors.key = t('dashboard.admin.instance.properties.errors.keyFormat');
		isValid = false;
	}

	return isValid;
};

// Validate edit form
const validateEditForm = (): boolean => {
	editFormErrors.label = '';

	if (!editForm.label.trim()) {
		editFormErrors.label = t('dashboard.admin.instance.properties.errors.labelRequired');
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

	if (!result.ok) return;

	showToast(t('dashboard.admin.instance.properties.toasts.created', { label: createForm.label }));
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

	if (!result.ok) return;

	showToast(t('dashboard.admin.instance.properties.toasts.updated'));
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

	if (!result.ok) return;

	showToast(
		t('dashboard.admin.instance.properties.toasts.deleted', {
			label: propertyToDelete.value.label,
		})
	);
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
				to="/dashboard/admin"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				{{ t('dashboard.admin.instance.properties.backToSettings') }}
			</NuxtLink>
			<div class="flex items-center justify-between">
				<div>
					<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ t('dashboard.admin.instance.properties.title') }}
					</h1>
					<p class="mt-1 text-text-secondary">
						{{ t('dashboard.admin.instance.properties.subtitle') }}
					</p>
				</div>
				<UiButton @click="openCreateModal()">
					<template #iconLeft>
						<Icon name="lucide:plus" class="w-4 h-4" />
					</template>
					{{ t('dashboard.admin.instance.properties.newProperty') }}
				</UiButton>
			</div>
		</div>

		<UiQueryBoundary
			:loading="isLoading && !propertiesData"
			:error="propertiesError"
			:error-title="t('dashboard.admin.instance.properties.errorTitle')"
			:loading-label="t('dashboard.admin.instance.properties.loading')"
		>
			<!-- No Team State -->
			<UiCard v-if="!hasActiveOrganization">
				<UiEmptyState
					icon="lucide:tags"
					:title="t('dashboard.admin.instance.properties.noTeamTitle')"
					:description="t('dashboard.admin.instance.properties.noTeamBody')"
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
								<h2 class="text-lg font-semibold text-text-primary">
									{{ t('dashboard.admin.instance.properties.cardTitle') }}
								</h2>
								<p class="text-sm text-text-secondary">
									{{
										t(
											'dashboard.admin.instance.properties.customFieldCount',
											{ count: propertiesData?.length || 0 },
											propertiesData?.length || 0
										)
									}}
								</p>
							</div>
						</div>
					</template>

					<!-- Empty State -->
					<UiEmptyState
						v-if="!propertiesData || propertiesData.length === 0"
						icon="lucide:tags"
						:title="t('dashboard.admin.instance.properties.emptyTitle')"
						:description="t('dashboard.admin.instance.properties.emptyBody')"
						class="py-12"
					>
						<template #action>
							<UiButton @click="openCreateModal()">
								<template #iconLeft>
									<Icon name="lucide:plus" class="w-4 h-4" />
								</template>
								{{ t('dashboard.admin.instance.properties.createFirst') }}
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
											{{ t(getTypeInfo(property.type).label) }}
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
											{{ t('common.edit') }}
										</button>
										<button
											class="w-full px-4 py-2 text-left text-sm text-error hover:bg-bg-surface flex items-center gap-2"
											@click="openDeleteModal(property)"
										>
											<Icon name="lucide:trash-2" class="w-4 h-4" />
											{{ t('common.delete') }}
										</button>
									</div>
								</Transition>
							</div>
						</div>
					</div>
				</UiCard>

				<!-- Info Card -->
				<UiCard>
					<h3 class="text-sm font-medium text-text-primary mb-4">
						{{ t('dashboard.admin.instance.properties.typesTitle') }}
					</h3>
					<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
						<div v-for="type in propertyTypes" :key="type.value" class="flex items-start gap-3">
							<div class="p-2 rounded-lg bg-bg-surface flex items-center justify-center">
								<Icon :name="type.icon" class="w-4 h-4 text-text-secondary" />
							</div>
							<div>
								<p class="font-medium text-text-primary text-sm">{{ t(type.label) }}</p>
								<p class="text-xs text-text-secondary mt-0.5">{{ t(type.description) }}</p>
							</div>
						</div>
					</div>
				</UiCard>
			</div>
		</UiQueryBoundary>

		<!-- Create Property Modal -->
		<UiModal
			v-model:open="isCreateModalOpen"
			:title="t('dashboard.admin.instance.properties.createModal.title')"
		>
			<form @submit.prevent="handleCreate">
				<div class="space-y-4">
					<!-- Label -->
					<UiInput
						v-model="createForm.label"
						:label="t('dashboard.admin.instance.properties.fields.label')"
						:placeholder="t('dashboard.admin.instance.properties.fields.labelPlaceholder')"
						:error="createFormErrors.label"
						:disabled="isCreating"
						:required="true"
						:help-text="
							!createFormErrors.label
								? t('dashboard.admin.instance.properties.fields.labelHelp')
								: undefined
						"
					/>

					<!-- Key -->
					<div>
						<UiInput
							v-model="createForm.key"
							:label="t('dashboard.admin.instance.properties.fields.key')"
							:placeholder="t('dashboard.admin.instance.properties.fields.keyPlaceholder')"
							:error="createFormErrors.key"
							:disabled="isCreating"
							:required="true"
						/>
						<I18nT
							v-if="!createFormErrors.key"
							keypath="dashboard.admin.instance.properties.fields.keyHelp"
							tag="p"
							scope="global"
							class="mt-1 text-xs text-text-tertiary"
						>
							<template #token>
								<code class="px-1 py-0.5 rounded bg-bg-surface text-text-primary"
									>&#123;&#123;{{
										createForm.key || t('dashboard.admin.instance.properties.fields.keyFallback')
									}}&#125;&#125;</code
								>
							</template>
						</I18nT>
					</div>

					<!-- Type -->
					<div>
						<label class="label">{{ t('dashboard.admin.instance.properties.fields.type') }}</label>
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
									<span class="font-medium text-text-primary text-sm">{{ t(type.label) }}</span>
								</div>
								<p class="text-xs text-text-secondary">{{ t(type.description) }}</p>
							</button>
						</div>
					</div>
				</div>
			</form>

			<template #footer>
				<UiButton variant="secondary" :disabled="isCreating" @click="closeCreateModal()">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton :loading="isCreating" @click="handleCreate">
					<template #iconLeft>
						<Icon v-if="!isCreating" name="lucide:plus" class="w-4 h-4" />
					</template>
					{{
						isCreating
							? t('dashboard.admin.instance.properties.createModal.creating')
							: t('dashboard.admin.instance.properties.createModal.create')
					}}
				</UiButton>
			</template>
		</UiModal>

		<!-- Edit Property Modal -->
		<UiModal
			v-model:open="isEditModalOpen"
			:title="t('dashboard.admin.instance.properties.editModal.title')"
		>
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
							<p class="text-sm text-text-tertiary">
								{{ t('dashboard.admin.instance.properties.fields.key') }}
							</p>
							<p class="font-mono text-text-primary">{{ editingProperty.key }}</p>
						</div>
					</div>
					<p class="mt-3 text-xs text-text-tertiary">
						{{ t('dashboard.admin.instance.properties.editModal.immutable') }}
					</p>
				</div>

				<!-- Label -->
				<UiInput
					v-model="editForm.label"
					:label="t('dashboard.admin.instance.properties.fields.label')"
					:placeholder="t('dashboard.admin.instance.properties.fields.labelPlaceholder')"
					:error="editFormErrors.label"
					:disabled="isEditing"
					:required="true"
				/>
			</div>

			<template #footer>
				<UiButton variant="secondary" :disabled="isEditing" @click="isEditModalOpen = false">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton :loading="isEditing" @click="handleEdit">
					<template #iconLeft>
						<Icon v-if="!isEditing" name="lucide:check" class="w-4 h-4" />
					</template>
					{{
						isEditing
							? t('dashboard.admin.instance.properties.editModal.saving')
							: t('dashboard.admin.instance.properties.editModal.save')
					}}
				</UiButton>
			</template>
		</UiModal>

		<!-- Delete Property Modal -->
		<UiModal
			:open="!!propertyToDelete"
			:title="t('dashboard.admin.instance.properties.deleteModal.title')"
			@update:open="(v: boolean) => !v && (propertyToDelete = null)"
		>
			<I18nT
				keypath="dashboard.admin.instance.properties.deleteModal.question"
				tag="p"
				scope="global"
				class="text-text-secondary"
			>
				<template #name>
					<span v-if="propertyToDelete" class="font-medium text-text-primary"
						>"{{ propertyToDelete.label }}"</span
					>
				</template>
			</I18nT>

			<!-- Warning about data -->
			<div
				v-if="isLoadingUsageCount"
				class="mt-4 p-4 rounded-xl bg-bg-surface border border-border-subtle flex items-center gap-3"
			>
				<Icon name="lucide:loader-2" class="w-4 h-4 animate-spin text-text-tertiary" />
				<span class="text-sm text-text-tertiary">
					{{ t('dashboard.admin.instance.properties.deleteModal.checkingUsage') }}
				</span>
			</div>
			<div
				v-else-if="deletePropertyUsageCount > 0"
				class="mt-4 p-4 rounded-xl bg-warning-subtle border border-warning/20"
			>
				<div class="flex items-start gap-3">
					<Icon name="lucide:alert-circle" class="w-5 h-5 text-warning mt-0.5 flex-shrink-0" />
					<div>
						<p class="font-medium text-warning">
							{{ t('dashboard.admin.instance.properties.deleteModal.dataWarningTitle') }}
						</p>
						<p class="text-sm text-warning/80 mt-1">
							{{
								t(
									'dashboard.admin.instance.properties.deleteModal.dataWarningBody',
									{ count: deletePropertyUsageCount },
									deletePropertyUsageCount
								)
							}}
						</p>
					</div>
				</div>
			</div>

			<template #footer>
				<UiButton variant="secondary" :disabled="isDeleting" @click="propertyToDelete = null">
					{{ t('common.cancel') }}
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
					{{
						isDeleting
							? t('dashboard.admin.instance.properties.deleteModal.deleting')
							: t('dashboard.admin.instance.properties.deleteModal.confirm')
					}}
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
