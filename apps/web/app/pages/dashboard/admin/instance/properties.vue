<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import CreatePropertyModal from '~/components/contactProperties/CreatePropertyModal.vue';
import DeletePropertyModal from '~/components/contactProperties/DeletePropertyModal.vue';
import EditPropertyModal from '~/components/contactProperties/EditPropertyModal.vue';
import PropertyRow from '~/components/contactProperties/PropertyRow.vue';
import {
	CalendarIcon,
	HashIcon,
	PlusIcon,
	TagsIcon,
	TextIcon,
	ToggleLeftIcon,
} from '@coolicons/vue';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.instance.properties.pageTitle') });

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'admin'],
});

// Get the current user's organization
const { hasActiveOrganization, isLoading: teamLoading } = useOrganizationContext();

// Get contact properties with real-time updates. Properties being deleted are
// included (with their deletion progress) so the page can show them as such;
// every other picker gets the live ones only.
const {
	data: propertiesData,
	isLoading: propertiesLoading,
	error: propertiesError,
	refetch: refetchProperties,
} = useOrganizationQuery(api.contacts.properties.listByOrganization, () => ({
	includePendingDeletion: true,
}));

type ListedProperty = NonNullable<typeof propertiesData.value>[number];

/** A property whose values are still being removed in the background. */
const isPendingDeletion = (property: ListedProperty) => property.deletionRequestedAt !== undefined;

const liveCount = computed(
	() => (propertiesData.value ?? []).filter((property) => !isPendingDeletion(property)).length
);

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
		icon: TextIcon,
		description: 'dashboard.admin.instance.properties.types.string.description',
	},
	{
		value: 'number',
		label: 'dashboard.admin.instance.properties.types.number.label',
		icon: HashIcon,
		description: 'dashboard.admin.instance.properties.types.number.description',
	},
	{
		value: 'boolean',
		label: 'dashboard.admin.instance.properties.types.boolean.label',
		icon: ToggleLeftIcon,
		description: 'dashboard.admin.instance.properties.types.boolean.description',
	},
	{
		value: 'date',
		label: 'dashboard.admin.instance.properties.types.date.label',
		icon: CalendarIcon,
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
const openEditModal = (property: ListedProperty) => {
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
const openDeleteModal = async (property: ListedProperty) => {
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

	// `pending`: the values go in bounded batches; the row stays listed as
	// deleting until the last one is gone. Older backends return nothing.
	const toastKey =
		result.result === 'pending'
			? 'dashboard.admin.instance.properties.toasts.deletionStarted'
			: 'dashboard.admin.instance.properties.toasts.deleted';
	showToast(t(toastKey, { label: propertyToDelete.value.label }));
	propertyToDelete.value = null;
};

// Re-arm a deletion that stopped after repeated errors. The same mutation
// joins or restarts the job; it never starts a second one.
const retryingDeletion = ref<Id<'contactProperties'> | null>(null);
const retryDeletion = async (property: ListedProperty) => {
	retryingDeletion.value = property._id;
	await removeProperty({ propertyId: property._id });
	retryingDeletion.value = null;
};

// Close dropdown on click outside
useClickOutsideSelector('[data-property-dropdown]', () => {
	openDropdown.value = null;
});
</script>

<template>
	<div>
		<UiPageHeader
			:title="t('dashboard.admin.instance.properties.title')"
			:description="t('dashboard.admin.instance.properties.subtitle')"
			class="mb-6"
		>
			<template #actions>
				<UiButton @click="openCreateModal()">
					<template #iconLeft>
						<PlusIcon class="w-4 h-4" />
					</template>
					{{ t('dashboard.admin.instance.properties.newProperty') }}
				</UiButton>
			</template>
		</UiPageHeader>

		<UiQueryBoundary
			:loading="isLoading && !propertiesData"
			:error="propertiesError"
			@retry="refetchProperties"
			:error-title="t('dashboard.admin.instance.properties.errorTitle')"
			:loading-label="t('dashboard.admin.instance.properties.loading')"
		>
			<!-- No Team State -->
			<UiCard v-if="!hasActiveOrganization">
				<UiEmptyState
					:icon="TagsIcon"
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
							<UiIconBox :icon="TagsIcon" size="sm" variant="surface" rounded="lg" />
							<div>
								<h2 class="text-lg font-semibold text-text-primary">
									{{ t('dashboard.admin.instance.properties.cardTitle') }}
								</h2>
								<p class="text-sm text-text-secondary">
									{{
										t(
											'dashboard.admin.instance.properties.customFieldCount',
											{ count: liveCount },
											liveCount
										)
									}}
								</p>
							</div>
						</div>
					</template>

					<!-- Empty State -->
					<UiEmptyState
						v-if="!propertiesData || propertiesData.length === 0"
						:icon="TagsIcon"
						:title="t('dashboard.admin.instance.properties.emptyTitle')"
						:description="t('dashboard.admin.instance.properties.emptyBody')"
						class="py-12"
					>
						<template #action>
							<UiButton @click="openCreateModal()">
								<template #iconLeft>
									<PlusIcon class="w-4 h-4" />
								</template>
								{{ t('dashboard.admin.instance.properties.createFirst') }}
							</UiButton>
						</template>
					</UiEmptyState>

					<!-- Properties Table -->
					<div v-else class="divide-y divide-border-subtle">
						<PropertyRow
							v-for="property in propertiesData"
							:key="property._id"
							:property="property"
							:type-icon="getTypeInfo(property.type).icon"
							:type-label="t(getTypeInfo(property.type).label)"
							:pending-deletion="isPendingDeletion(property)"
							:retrying="retryingDeletion === property._id"
							:menu-open="openDropdown === property._id"
							@toggle-menu="openDropdown = openDropdown === property._id ? null : property._id"
							@edit="openEditModal(property)"
							@delete="openDeleteModal(property)"
							@retry="retryDeletion(property)"
						/>
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
								<component :is="type.icon" class="w-4 h-4 text-text-secondary" />
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
		<CreatePropertyModal
			v-model:open="isCreateModalOpen"
			:form="createForm"
			:errors="createFormErrors"
			:is-creating="isCreating"
			:types="propertyTypes"
			@submit="handleCreate"
			@cancel="closeCreateModal()"
		/>

		<!-- Edit Property Modal -->
		<EditPropertyModal
			v-model:open="isEditModalOpen"
			:property="editingProperty"
			:type-icon="getTypeInfo(editingProperty?.type ?? '').icon"
			:form="editForm"
			:errors="editFormErrors"
			:is-saving="isEditing"
			@submit="handleEdit"
		/>

		<!-- Delete Property Modal -->
		<DeletePropertyModal
			:property="propertyToDelete"
			:is-loading-usage-count="isLoadingUsageCount"
			:usage-count="deletePropertyUsageCount"
			:is-deleting="isDeleting"
			@close="propertyToDelete = null"
			@confirm="handleDelete"
		/>
	</div>
</template>
