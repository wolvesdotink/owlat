<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Email Blocks — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();

// Get the current user's organization
const { hasActiveOrganization, isLoading: teamLoading } = useOrganizationContext();

// Sort state
type SortOption = 'recent' | 'mostUsed' | 'name';
const selectedSort = ref<SortOption>('recent');

const sortOptions: { value: SortOption; label: string; icon: string }[] = [
	{ value: 'recent', label: 'Most Recent', icon: 'lucide:clock' },
	{ value: 'mostUsed', label: 'Most Used', icon: 'lucide:trending-up' },
	{ value: 'name', label: 'Name (A-Z)', icon: 'lucide:arrow-down-a-z' },
];

// Search state
const searchQuery = ref('');
const debouncedSearch = ref('');
let searchTimeout: ReturnType<typeof setTimeout> | null = null;

// Debounce search input
watch(searchQuery, (value) => {
	if (searchTimeout) {
		clearTimeout(searchTimeout);
	}
	searchTimeout = setTimeout(() => {
		debouncedSearch.value = value;
	}, 300);
});

// Fetch blocks with real-time updates (uses session-based organization context)
const {
	data: blocks,
	isLoading: blocksLoading,
	error: blocksError,
} = useConvexQuery(api.emailBlocks.blocks.list, () => ({
	search: debouncedSearch.value || undefined,
	sortBy: selectedSort.value,
}));

// Fetch block stats
const { data: blockStats } = useOrganizationQuery(api.emailBlocks.blocks.getStatsByTeam);

const isLoading = computed(() => teamLoading.value || blocksLoading.value);

// Mutations (createBlock uses session-based organization context)
const { run: duplicateBlock } = useBackendOperation(api.emailBlocks.blocks.duplicate, {
	label: 'Duplicate block',
});
const { run: deleteBlock } = useBackendOperation(api.emailBlocks.blocks.remove, {
	label: 'Delete block',
});
const { run: createBlock } = useBackendOperation(api.emailBlocks.blocks.create, {
	label: 'Create block',
});

// Action dropdown state (using reactive object for AppUiDropdownMenu v-model:open per item)
const dropdownOpenStates = reactive<Record<string, boolean>>({});

// Toast notification
const { showToast: showNotification } = useToast();

// Handle duplicate
const handleDuplicate = async (blockId: Id<'emailBlocks'>) => {
	const result = await duplicateBlock({ blockId });
	if (result === undefined) return;
	showNotification('Block duplicated successfully');
};

// Delete confirmation modal
const isDeleteModalOpen = ref(false);
const blockToDelete = ref<{ id: Id<'emailBlocks'>; name: string; usageCount: number } | null>(null);
const isDeleting = ref(false);

const openDeleteModal = (id: Id<'emailBlocks'>, name: string, usageCount: number) => {
	blockToDelete.value = { id, name, usageCount };
	isDeleteModalOpen.value = true;
};

const closeDeleteModal = () => {
	isDeleteModalOpen.value = false;
	blockToDelete.value = null;
};

const handleDelete = async () => {
	if (!blockToDelete.value) return;

	isDeleting.value = true;
	try {
		const result = await deleteBlock({ blockId: blockToDelete.value.id });
		if (result === undefined) return;
		showNotification('Block deleted successfully');
		closeDeleteModal();
	} finally {
		isDeleting.value = false;
	}
};

// Create new block modal
const isCreateModalOpen = ref(false);
const createForm = reactive({
	name: '',
	description: '',
});
const createFormErrors = reactive({
	name: '',
});
const isCreating = ref(false);

const openCreateModal = () => {
	createForm.name = '';
	createForm.description = '';
	createFormErrors.name = '';
	isCreateModalOpen.value = true;
};

const closeCreateModal = () => {
	isCreateModalOpen.value = false;
};

const handleCreate = async () => {
	// Reset errors
	createFormErrors.name = '';

	// Validate
	if (!createForm.name.trim()) {
		createFormErrors.name = 'Name is required';
		return;
	}

	isCreating.value = true;

	try {
		// Uses session-based organization context - no teamId needed
		// Returns the ID of the created block
		const blockId = await createBlock({
			name: createForm.name.trim(),
			description: createForm.description.trim() || undefined,
			content: JSON.stringify({ blocks: [] }), // Empty multi-block content
		});
		if (blockId === undefined) return;

		closeCreateModal();
		// Navigate directly to the editor to add content
		router.push(`/dashboard/send/blocks/${blockId}/edit`);
	} finally {
		isCreating.value = false;
	}
};

// Edit modal (placeholder for future full editing)
const isEditModalOpen = ref(false);
const blockToEdit = ref<{
	id: Id<'emailBlocks'>;
	name: string;
	description?: string;
} | null>(null);
const editForm = reactive({
	name: '',
	description: '',
});
const editFormErrors = reactive({
	name: '',
});
const isEditing = ref(false);
const { run: updateBlock } = useBackendOperation(api.emailBlocks.blocks.update, {
	label: 'Update block',
});

const openEditModal = (block: { _id: Id<'emailBlocks'>; name: string; description?: string }) => {
	blockToEdit.value = {
		id: block._id,
		name: block.name,
		description: block.description,
	};
	editForm.name = block.name;
	editForm.description = block.description || '';
	editFormErrors.name = '';
	isEditModalOpen.value = true;
};

const closeEditModal = () => {
	isEditModalOpen.value = false;
	blockToEdit.value = null;
};

const handleEdit = async () => {
	if (!blockToEdit.value) return;

	// Reset errors
	editFormErrors.name = '';

	// Validate
	if (!editForm.name.trim()) {
		editFormErrors.name = 'Name is required';
		return;
	}

	isEditing.value = true;

	try {
		const result = await updateBlock({
			blockId: blockToEdit.value.id,
			name: editForm.name.trim(),
			description: editForm.description.trim() || undefined,
		});
		if (result === undefined) return;

		showNotification('Block updated successfully');
		closeEditModal();
	} finally {
		isEditing.value = false;
	}
};

// Navigate to the full edit page for content editing
const navigateToEditPage = (blockId: Id<'emailBlocks'>) => {
	router.push(`/dashboard/send/blocks/${blockId}/edit`);
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">Saved Blocks</h1>
				<p class="mt-1 text-text-secondary">Reusable email components for your templates</p>
			</div>
			<UiButton size="sm" @click="openCreateModal">
				<template #iconLeft>
					<Icon name="lucide:plus" class="w-4 h-4" />
				</template>
				New Block
			</UiButton>
		</div>

		<!-- Filters and Search -->
		<div class="flex flex-col sm:flex-row sm:items-center gap-4 mb-6">
			<!-- Stats -->
			<div v-if="blockStats" class="text-sm text-text-secondary">
				{{ blockStats.total }} block{{ blockStats.total !== 1 ? 's' : '' }}
			</div>

			<div class="flex-1" />

			<!-- Sort Dropdown -->
			<div class="relative">
				<select v-model="selectedSort" class="input input-sm pr-8 appearance-none cursor-pointer">
					<option v-for="option in sortOptions" :key="option.value" :value="option.value">
						{{ option.label }}
					</option>
				</select>
				<Icon
					name="lucide:arrow-up-down"
					class="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary pointer-events-none"
				/>
			</div>

			<!-- Search -->
			<UiInput
				v-model="searchQuery"
				type="text"
				placeholder="Search blocks..."
				size="sm"
				class="w-64"
			>
				<template #iconLeft>
					<Icon name="lucide:search" class="w-4 h-4 text-text-tertiary" />
				</template>
			</UiInput>
		</div>

		<!-- Content -->
		<div>
			<UiQueryBoundary :loading="isLoading && !blocks" :error="blocksError">
				<template #loading>
					<div class="flex items-center justify-center py-16">
						<div class="flex flex-col items-center gap-3">
							<UiSpinner />
							<p class="text-text-secondary text-sm">Loading blocks...</p>
						</div>
					</div>
				</template>

				<!-- Empty State (no organization) -->
				<UiEmptyState
					v-if="!hasActiveOrganization"
					icon="lucide:blocks"
					title="No workspace selected"
					description="Create or select a workspace to start managing reusable blocks."
				/>

				<!-- Empty State (no blocks) -->
				<UiEmptyState
					v-else-if="!isLoading && (!blocks || blocks.length === 0) && !debouncedSearch"
					icon="lucide:blocks"
					title="No saved blocks yet"
					description="Save blocks from your email templates to reuse across multiple emails."
				>
					<template #action>
						<UiButton @click="openCreateModal">
							<template #iconLeft>
								<Icon name="lucide:plus" class="w-4 h-4" />
							</template>
							Create Block
						</UiButton>
					</template>
				</UiEmptyState>

				<!-- Empty State (no search results) -->
				<UiEmptyState
					v-else-if="!isLoading && (!blocks || blocks.length === 0) && debouncedSearch"
					icon="lucide:search"
					title="No results found"
					:description="`No blocks match &quot;${debouncedSearch}&quot;. Try a different search term.`"
				>
					<template #action>
						<UiButton
							variant="secondary"
							@click="
								searchQuery = '';
								debouncedSearch = '';
							"
						>
							Clear search
						</UiButton>
					</template>
				</UiEmptyState>

				<!-- Grid View -->
				<div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
					<UiCard
						v-for="block in blocks"
						:key="block._id"
						padding="none"
						overflow="hidden"
						hoverable
						clickable
						class="group"
						@click="navigateToEditPage(block._id)"
					>
						<!-- Thumbnail Area -->
						<div class="aspect-[4/3] bg-bg-surface flex items-center justify-center relative">
							<Icon name="lucide:blocks" class="w-12 h-12 text-text-tertiary/30" />
							<!-- Hover Overlay -->
							<div
								class="absolute inset-0 bg-bg-deep/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2"
							>
								<button
									class="p-2 rounded-lg bg-bg-elevated text-text-primary hover:bg-brand hover:text-text-inverse transition-colors"
									title="Edit Content"
									@click.stop="navigateToEditPage(block._id)"
								>
									<Icon name="lucide:file-edit" class="w-4 h-4" />
								</button>
								<button
									class="p-2 rounded-lg bg-bg-elevated text-text-primary hover:bg-brand hover:text-text-inverse transition-colors"
									title="Quick Settings"
									@click.stop="openEditModal(block)"
								>
									<Icon name="lucide:settings" class="w-4 h-4" />
								</button>
								<button
									class="p-2 rounded-lg bg-bg-elevated text-text-primary hover:bg-brand hover:text-text-inverse transition-colors"
									title="Duplicate"
									@click.stop="handleDuplicate(block._id)"
								>
									<Icon name="lucide:copy" class="w-4 h-4" />
								</button>
								<button
									class="p-2 rounded-lg bg-bg-elevated text-text-primary hover:bg-error hover:text-white transition-colors"
									title="Delete"
									@click.stop="openDeleteModal(block._id, block.name, block.usageCount)"
								>
									<Icon name="lucide:trash-2" class="w-4 h-4" />
								</button>
							</div>
						</div>

						<!-- Info -->
						<div class="p-4">
							<div class="flex items-start justify-between gap-2">
								<div class="min-w-0 flex-1">
									<h3 class="font-medium text-text-primary truncate">{{ block.name }}</h3>
									<p class="text-sm text-text-tertiary truncate mt-0.5">
										{{ block.description || 'No description' }}
									</p>
								</div>
								<!-- Dropdown Menu -->
								<UiDropdownMenu v-model:open="dropdownOpenStates[block._id]" @click.stop>
									<template #trigger>
										<UiButton variant="ghost" size="sm">
											<Icon name="lucide:more-vertical" class="w-4 h-4" />
										</UiButton>
									</template>
									<UiDropdownMenuItem
										icon="lucide:file-edit"
										@click="navigateToEditPage(block._id)"
									>
										Edit Content
									</UiDropdownMenuItem>
									<UiDropdownMenuItem icon="lucide:settings" @click="openEditModal(block)">
										Settings
									</UiDropdownMenuItem>
									<UiDropdownMenuItem icon="lucide:copy" @click="handleDuplicate(block._id)">
										Duplicate
									</UiDropdownMenuItem>
									<UiDropdownDivider />
									<UiDropdownMenuItem
										icon="lucide:trash-2"
										danger
										@click="openDeleteModal(block._id, block.name, block.usageCount)"
									>
										Delete
									</UiDropdownMenuItem>
								</UiDropdownMenu>
							</div>

							<!-- Meta Info -->
							<div class="flex items-center gap-2 mt-3">
								<span
									v-if="block.blockCount && block.blockCount > 1"
									class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-brand/10 text-brand"
								>
									{{ block.blockCount }} blocks
								</span>
								<span
									class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-bg-surface text-text-tertiary"
								>
									<Icon name="lucide:bar-chart" class="w-3 h-3" />
									{{ block.usageCount }} uses
								</span>
							</div>

							<p class="text-xs text-text-tertiary mt-3">
								Updated {{ formatDate(block.updatedAt) }}
							</p>
						</div>
					</UiCard>
				</div>
			</UiQueryBoundary>
		</div>

		<!-- Create Modal -->
		<UiModal v-model:open="isCreateModalOpen" title="Create Block" :persistent="isCreating">
			<form @submit.prevent="handleCreate">
				<!-- Name Field -->
				<UiInput
					id="block-name"
					v-model="createForm.name"
					type="text"
					label="Name"
					required
					placeholder="e.g., Hero Banner, Call to Action"
					:error="createFormErrors.name"
					:disabled="isCreating"
					class="mb-4"
				/>

				<!-- Description Field -->
				<UiTextarea
					id="block-description"
					v-model="createForm.description"
					label="Description"
					:rows="2"
					placeholder="Brief description of the block..."
					:disabled="isCreating"
					class="mb-4"
				/>
			</form>

			<template #footer>
				<UiButton variant="secondary" :disabled="isCreating" @click="closeCreateModal">
					Cancel
				</UiButton>
				<UiButton :loading="isCreating" @click="handleCreate">
					{{ isCreating ? 'Creating...' : 'Create Block' }}
				</UiButton>
			</template>
		</UiModal>

		<!-- Edit Modal -->
		<UiModal v-model:open="isEditModalOpen" title="Edit Block" :persistent="isEditing">
			<form @submit.prevent="handleEdit">
				<!-- Name Field -->
				<UiInput
					id="edit-block-name"
					v-model="editForm.name"
					type="text"
					label="Name"
					required
					placeholder="e.g., Hero Banner, Call to Action"
					:error="editFormErrors.name"
					:disabled="isEditing"
					class="mb-4"
				/>

				<!-- Description Field -->
				<UiTextarea
					id="edit-block-description"
					v-model="editForm.description"
					label="Description"
					:rows="2"
					placeholder="Brief description of the block..."
					:disabled="isEditing"
					class="mb-4"
				/>
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
		<UiModal v-model:open="isDeleteModalOpen" title="Delete Block" :persistent="isDeleting">
			<div class="flex items-start gap-4">
				<div class="p-3 rounded-full bg-error/10 shrink-0 flex items-center justify-center">
					<Icon name="lucide:trash-2" class="w-6 h-6 text-error" />
				</div>
				<div>
					<p class="text-text-primary">
						Are you sure you want to delete
						<span class="font-semibold">"{{ blockToDelete?.name }}"</span>?
					</p>
					<p class="text-sm text-text-secondary mt-2">
						This action cannot be undone. The block will be removed from the library.
					</p>
					<p v-if="blockToDelete && blockToDelete.usageCount > 0" class="text-sm text-warning mt-2">
						This block has been used {{ blockToDelete.usageCount }} time{{
							blockToDelete.usageCount !== 1 ? 's' : ''
						}}. Linked instances in emails will be automatically detached.
					</p>
				</div>
			</div>

			<template #footer>
				<UiButton variant="secondary" :disabled="isDeleting" @click="closeDeleteModal">
					Cancel
				</UiButton>
				<UiButton variant="danger" :loading="isDeleting" @click="handleDelete">
					{{ isDeleting ? 'Deleting...' : 'Delete Block' }}
				</UiButton>
			</template>
		</UiModal>
	</div>
</template>
