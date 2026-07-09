<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Subscription topics — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Get the current user's organization
const { hasActiveOrganization, isLoading: organizationLoading } = useOrganizationContext();

// Fetch topics with cursor-based pagination (uses session-based organization
// context). The list sorts/filters client-side, so — like Segments — eagerly
// pull every page: otherwise a client sort would only reorder the loaded rows
// (a misleading partial-set sort) and an org with >50 topics would be capped.
const {
	results: topics,
	status: paginationStatus,
	loadMore,
	isLoading: topicsLoading,
} = usePaginatedQuery(api.topics.topics.list, () => ({}), { initialNumItems: 50 });

watch(
	paginationStatus,
	(s) => {
		if (s === 'CanLoadMore') loadMore(50);
	},
	{ immediate: true }
);

const isLoading = computed(() => organizationLoading.value || topicsLoading.value);

// Data table controls (search and sort) — shared contract with the other
// audience list pages: identical debounced search + sort affordance.
type SortField = 'name' | 'contactCount' | 'createdAt';
const { searchQuery, debouncedSearch, sortBy, sortOrder, toggleSort, getSortIcon } =
	useDataTable<SortField>({
		defaultSort: 'createdAt',
		defaultOrder: 'desc',
		sortableFields: ['name', 'contactCount', 'createdAt'],
	});

// Filtered and sorted topics (client-side over the fully-loaded set)
const filteredTopics = computed(() => {
	if (!topics.value) return [];

	let items = [...topics.value];

	// Filter by search
	if (debouncedSearch.value) {
		const query = debouncedSearch.value.toLowerCase();
		items = items.filter(
			(topic) =>
				topic.name.toLowerCase().includes(query) ||
				(topic.description && topic.description.toLowerCase().includes(query))
		);
	}

	// Sort
	items.sort((a, b) => {
		let comparison = 0;
		if (sortBy.value === 'name') {
			comparison = a.name.localeCompare(b.name);
		} else if (sortBy.value === 'contactCount') {
			comparison = a.contactCount - b.contactCount;
		} else if (sortBy.value === 'createdAt') {
			comparison = a.createdAt - b.createdAt;
		}
		return sortOrder.value === 'asc' ? comparison : -comparison;
	});

	return items;
});

// ============================================
// Create Modal State (using useFormModal)
// ============================================
const {
	isOpen: isCreateModalOpen,
	isSubmitting: isCreating,
	form: createForm,
	errors: createErrors,
	open: openCreateModal,
	close: closeCreateModal,
	clearErrors: clearCreateErrors,
} = useFormModal({
	name: '',
	description: '',
	requireDoubleOptIn: false,
});

// Create topic mutation (uses session-based organization context)
const { run: createTopic } = useBackendOperation(api.topics.topics.create, {
	label: 'Create topic',
});

// Validate create form
const validateCreateForm = (): boolean => {
	clearCreateErrors();

	if (!createForm.name.trim()) {
		createErrors.name = 'Topic name is required';
		return false;
	}

	return true;
};

// Handle create submission
const handleCreate = async () => {
	if (!validateCreateForm()) return;

	isCreating.value = true;

	// Uses session-based organization context - no teamId needed
	const result = await createTopic({
		name: createForm.name.trim(),
		description: createForm.description.trim() || undefined,
		// Send the explicit boolean: `|| undefined` would coerce an unchecked box
		// to undefined, which the backend defaults to `true` (DOI forced on).
		requireDoubleOptIn: createForm.requireDoubleOptIn,
	});
	isCreating.value = false;
	if (result === undefined) return;

	showToast(`Topic "${createForm.name.trim()}" created successfully`);
	closeCreateModal();
};

// ============================================
// Edit Modal State (using useFormModal)
// ============================================
const {
	isOpen: isEditModalOpen,
	isSubmitting: isEditing,
	form: editForm,
	errors: editErrors,
	close: closeEditModal,
	clearErrors: clearEditErrors,
	setForm: setEditForm,
} = useFormModal({
	id: '' as Id<'topics'> | '',
	name: '',
	description: '',
	requireDoubleOptIn: false,
});

// Update topic mutation
const { run: updateTopic } = useBackendOperation(api.topics.topics.update, {
	label: 'Update topic',
});

// Open edit modal with topic data
const openEditModal = (topic: {
	_id: Id<'topics'>;
	name: string;
	description?: string;
	requireDoubleOptIn?: boolean;
}) => {
	setEditForm({
		id: topic._id,
		name: topic.name,
		description: topic.description || '',
		requireDoubleOptIn: topic.requireDoubleOptIn || false,
	});
	clearEditErrors();
	isEditModalOpen.value = true;
};

// Validate edit form
const validateEditForm = (): boolean => {
	clearEditErrors();

	if (!editForm.name.trim()) {
		editErrors.name = 'Topic name is required';
		return false;
	}

	return true;
};

// Handle edit submission
const handleEdit = async () => {
	if (!validateEditForm() || !editForm.id) return;

	isEditing.value = true;

	const result = await updateTopic({
		topicId: editForm.id as Id<'topics'>,
		name: editForm.name.trim(),
		description: editForm.description.trim() || undefined,
		requireDoubleOptIn: editForm.requireDoubleOptIn,
	});
	isEditing.value = false;
	if (result === undefined) return;

	showToast(`Topic "${editForm.name.trim()}" updated successfully`);
	closeEditModal();
};

// ============================================
// Delete Modal State
// ============================================
const isDeleteModalOpen = ref(false);
const deleteTarget = ref<{
	id: Id<'topics'>;
	name: string;
	contactCount: number;
} | null>(null);
const isDeleting = ref(false);

// Delete topic mutation
const { run: deleteTopic } = useBackendOperation(api.topics.topics.remove, {
	label: 'Delete topic',
});

// Open delete modal
const openDeleteModal = (topic: { _id: Id<'topics'>; name: string; contactCount: number }) => {
	deleteTarget.value = {
		id: topic._id,
		name: topic.name,
		contactCount: topic.contactCount,
	};
	isDeleteModalOpen.value = true;
};

// Close delete modal
const closeDeleteModal = () => {
	isDeleteModalOpen.value = false;
	deleteTarget.value = null;
};

// Handle delete confirmation
const handleDelete = async () => {
	if (!deleteTarget.value) return;

	isDeleting.value = true;

	const result = await deleteTopic({ topicId: deleteTarget.value.id });
	isDeleting.value = false;
	if (result === undefined) return;
	showToast(`Topic "${deleteTarget.value.name}" deleted successfully`);
	closeDeleteModal();
};

// Toast notifications
const { showToast } = useToast();

// Navigate to view contacts in topic
const router = useRouter();
const viewTopicContacts = (topicId: Id<'topics'>) => {
	router.push(`/dashboard/audience/topics/${topicId}`);
};

// Auto-open the Create Topic modal when arriving via the audience overview
// quick-action link (/dashboard/audience/topics?action=create).
const route = useRoute();
onMounted(() => {
	if (route.query['action'] === 'create') {
		openCreateModal();
	}
});
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">Subscription topics</h1>
				<p class="mt-1 text-text-secondary">
					What contacts subscribe to — group them for targeted campaigns
				</p>
			</div>
			<UiButton @click="openCreateModal">
				<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
				New Topic
			</UiButton>
		</div>

		<!-- Search Bar -->
		<div class="mb-6 max-w-md">
			<UiInput v-model="searchQuery" placeholder="Search topics...">
				<template #iconLeft><Icon name="lucide:search" /></template>
			</UiInput>
		</div>

		<!-- Content -->
		<UiCard padding="none" overflow="hidden">
			<!-- Loading State -->
			<div v-if="isLoading && !topics" class="flex items-center justify-center py-16">
				<div class="flex flex-col items-center gap-3">
					<UiSpinner />
					<p class="text-text-secondary text-sm">Loading topics...</p>
				</div>
			</div>

			<!-- Empty State (no organization) -->
			<UiEmptyState
				v-else-if="!hasActiveOrganization"
				icon="lucide:list"
				title="No organization selected"
				description="Create or select an organization to start managing your topics."
			/>

			<!-- Empty State (no lists) -->
			<UiEmptyState
				v-else-if="!isLoading && filteredTopics.length === 0 && !searchQuery"
				icon="lucide:list"
				title="No topics yet"
				description="Create your first topic to organize contacts for targeted email campaigns."
			>
				<template #action>
					<UiButton @click="openCreateModal">
						<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
						New Topic
					</UiButton>
				</template>
			</UiEmptyState>

			<!-- Empty State (no search results) -->
			<UiEmptyState
				v-else-if="!isLoading && filteredTopics.length === 0 && searchQuery"
				icon="lucide:search"
				title="No results found"
				:description="`No topics match &quot;${searchQuery}&quot;. Try a different search term.`"
			>
				<template #action>
					<UiButton variant="secondary" @click="searchQuery = ''"> Clear search </UiButton>
				</template>
			</UiEmptyState>

			<!-- Data Table -->
			<div v-else>
				<div class="overflow-x-auto">
					<table class="w-full">
						<thead>
							<tr class="border-b border-border-subtle">
								<th
									class="text-left px-6 py-4 text-sm font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
									@click="toggleSort('name')"
								>
									<div class="flex items-center gap-1">
										Name
										<Icon v-if="getSortIcon('name')" :name="getSortIcon('name')!" class="w-4 h-4" />
									</div>
								</th>
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
									Description
								</th>
								<th
									class="text-left px-6 py-4 text-sm font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
									@click="toggleSort('contactCount')"
								>
									<div class="flex items-center gap-1">
										Contacts
										<Icon
											v-if="getSortIcon('contactCount')"
											:name="getSortIcon('contactCount')!"
											class="w-4 h-4"
										/>
									</div>
								</th>
								<th
									class="text-left px-6 py-4 text-sm font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
									@click="toggleSort('createdAt')"
								>
									<div class="flex items-center gap-1">
										Created
										<Icon
											v-if="getSortIcon('createdAt')"
											:name="getSortIcon('createdAt')!"
											class="w-4 h-4"
										/>
									</div>
								</th>
								<th class="text-right px-6 py-4 text-sm font-medium text-text-secondary">
									Actions
								</th>
							</tr>
						</thead>
						<tbody>
							<tr
								v-for="topic in filteredTopics"
								:key="topic._id"
								class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface transition-colors cursor-pointer"
								@click="viewTopicContacts(topic._id)"
							>
								<td class="px-6 py-4">
									<div class="flex items-center gap-3">
										<UiIconBox icon="lucide:list" size="sm" variant="surface" rounded="lg" />
										<span class="text-text-primary font-medium">{{ topic.name }}</span>
									</div>
								</td>
								<td class="px-6 py-4">
									<span class="text-text-secondary">{{ topic.description || '—' }}</span>
								</td>
								<td class="px-6 py-4">
									<div class="flex items-center gap-2">
										<Icon name="lucide:users" class="w-4 h-4 text-text-tertiary" />
										<span class="text-text-secondary">{{ topic.contactCount }}</span>
									</div>
								</td>
								<td class="px-6 py-4">
									<span class="text-text-tertiary text-sm">{{ formatDate(topic.createdAt) }}</span>
								</td>
								<td class="px-6 py-4">
									<div class="flex items-center justify-end gap-1">
										<button
											class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
											title="Edit topic"
											@click.stop="openEditModal(topic)"
										>
											<Icon name="lucide:pencil" class="w-4 h-4" />
										</button>
										<button
											class="p-2 rounded-lg text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors"
											title="Delete topic"
											@click.stop="openDeleteModal(topic)"
										>
											<Icon name="lucide:trash-2" class="w-4 h-4" />
										</button>
									</div>
								</td>
							</tr>
						</tbody>
					</table>
				</div>

				<!-- Count footer -->
				<div class="px-6 py-4 border-t border-border-subtle">
					<p class="text-sm text-text-tertiary">
						{{ filteredTopics.length }} topic{{ filteredTopics.length !== 1 ? 's' : '' }}
					</p>
				</div>
			</div>
		</UiCard>

		<!-- Create List Modal -->
		<UiModal v-model:open="isCreateModalOpen" title="Create Topic">
			<form @submit.prevent="handleCreate">
				<!-- General Error -->
				<div
					v-if="createErrors.general"
					class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20"
				>
					<p class="text-sm text-error">{{ createErrors.general }}</p>
				</div>

				<!-- Name Field -->
				<div class="mb-4">
					<UiInput
						v-model="createForm.name"
						label="Name"
						:required="true"
						placeholder="e.g., Newsletter Subscribers"
						:error="createErrors.name"
						:disabled="isCreating"
					/>
				</div>

				<!-- Description Field -->
				<div class="mb-4">
					<UiTextarea
						v-model="createForm.description"
						label="Description"
						:rows="3"
						placeholder="Optional description for this topic..."
						:disabled="isCreating"
					/>
				</div>

				<!-- Double Opt-In Toggle -->
				<div class="mb-6">
					<UiCheckbox
						v-model="createForm.requireDoubleOptIn"
						label="Require double opt-in"
						description="New subscribers must confirm their email before being added to this topic"
						:disabled="isCreating"
					/>
				</div>
			</form>

			<template #footer>
				<UiButton variant="secondary" :disabled="isCreating" @click="closeCreateModal">
					Cancel
				</UiButton>
				<UiButton :loading="isCreating" @click="handleCreate">
					{{ isCreating ? 'Creating...' : 'Create Topic' }}
				</UiButton>
			</template>
		</UiModal>

		<!-- Edit List Modal -->
		<UiModal v-model:open="isEditModalOpen" title="Edit Topic">
			<form @submit.prevent="handleEdit">
				<!-- General Error -->
				<div
					v-if="editErrors.general"
					class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20"
				>
					<p class="text-sm text-error">{{ editErrors.general }}</p>
				</div>

				<!-- Name Field -->
				<div class="mb-4">
					<UiInput
						v-model="editForm.name"
						label="Name"
						:required="true"
						placeholder="e.g., Newsletter Subscribers"
						:error="editErrors.name"
						:disabled="isEditing"
					/>
				</div>

				<!-- Description Field -->
				<div class="mb-4">
					<UiTextarea
						v-model="editForm.description"
						label="Description"
						:rows="3"
						placeholder="Optional description for this topic..."
						:disabled="isEditing"
					/>
				</div>

				<!-- Double Opt-In Toggle -->
				<div class="mb-6">
					<UiCheckbox
						v-model="editForm.requireDoubleOptIn"
						label="Require double opt-in"
						description="New subscribers must confirm their email before being added to this topic"
						:disabled="isEditing"
					/>
				</div>
			</form>

			<template #footer>
				<UiButton variant="secondary" :disabled="isEditing" @click="closeEditModal">
					Cancel
				</UiButton>
				<UiButton :loading="isEditing" @click="handleEdit">
					{{ isEditing ? 'Saving...' : 'Save Changes' }}
				</UiButton>
			</template>
		</UiModal>

		<!-- Delete Confirmation Modal -->
		<UiModal v-model:open="isDeleteModalOpen" title="Delete Topic">
			<div class="flex items-start gap-4 mb-6">
				<div class="p-3 rounded-full bg-error-subtle flex items-center justify-center">
					<Icon name="lucide:alert-triangle" class="w-6 h-6 text-error" />
				</div>
				<div>
					<p class="text-text-primary font-medium">
						Are you sure you want to delete "{{ deleteTarget?.name }}"?
					</p>
					<p class="text-sm text-text-secondary mt-1">
						This action cannot be undone.
						<template v-if="deleteTarget && deleteTarget.contactCount > 0">
							The {{ deleteTarget.contactCount }} contact{{
								deleteTarget.contactCount !== 1 ? 's' : ''
							}}
							in this topic will not be deleted, only removed from the topic.
						</template>
					</p>
				</div>
			</div>

			<template #footer>
				<UiButton variant="secondary" :disabled="isDeleting" @click="closeDeleteModal">
					Cancel
				</UiButton>
				<UiButton variant="danger" :loading="isDeleting" @click="handleDelete">
					<template v-if="!isDeleting" #iconLeft
						><Icon name="lucide:trash-2" class="w-4 h-4"
					/></template>
					{{ isDeleting ? 'Deleting...' : 'Delete Topic' }}
				</UiButton>
			</template>
		</UiModal>
	</div>
</template>
