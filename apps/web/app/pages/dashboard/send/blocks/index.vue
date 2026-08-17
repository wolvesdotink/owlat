<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

useHead({ title: () => t('dashboard.send.blocks.index.pageTitle') });

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

const sortOptions = computed<{ value: SortOption; label: string; icon: string }[]>(() => [
	{ value: 'recent', label: t('dashboard.send.blocks.index.sort.recent'), icon: 'lucide:clock' },
	{
		value: 'mostUsed',
		label: t('dashboard.send.blocks.index.sort.mostUsed'),
		icon: 'lucide:trending-up',
	},
	{
		value: 'name',
		label: t('dashboard.send.blocks.index.sort.name'),
		icon: 'lucide:arrow-down-a-z',
	},
]);

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
	label: () => t('dashboard.send.blocks.index.duplicateOperation'),
});
const { run: deleteBlock } = useBackendOperation(api.emailBlocks.blocks.remove, {
	label: () => t('dashboard.send.blocks.index.deleteOperation'),
});
const { run: createBlock } = useBackendOperation(api.emailBlocks.blocks.create, {
	label: () => t('dashboard.send.blocks.index.createOperation'),
});

// Action dropdown state (using reactive object for AppUiDropdownMenu v-model:open per item)
const dropdownOpenStates = reactive<Record<string, boolean>>({});

// Toast notification
const { showToast: showNotification } = useToast();

// Handle duplicate
const handleDuplicate = async (blockId: Id<'emailBlocks'>) => {
	const result = await duplicateBlock({ blockId });
	if (result === undefined) return;
	showNotification(t('dashboard.send.blocks.index.duplicatedToast'));
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
		showNotification(t('dashboard.send.blocks.index.deletedToast'));
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
		createFormErrors.name = t('dashboard.send.blocks.index.nameRequired');
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
	label: () => t('dashboard.send.blocks.index.updateOperation'),
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
		editFormErrors.name = t('dashboard.send.blocks.index.nameRequired');
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

		showNotification(t('dashboard.send.blocks.index.updatedToast'));
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
				<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
					{{ t('dashboard.send.blocks.index.title') }}
				</h1>
				<p class="mt-1 text-text-secondary">{{ t('dashboard.send.blocks.index.subtitle') }}</p>
			</div>
			<UiButton size="sm" @click="openCreateModal">
				<template #iconLeft>
					<Icon name="lucide:plus" class="w-4 h-4" />
				</template>
				{{ t('dashboard.send.blocks.index.newBlock') }}
			</UiButton>
		</div>

		<!-- Filters and Search -->
		<div class="flex flex-col sm:flex-row sm:items-center gap-4 mb-6">
			<!-- Stats -->
			<div v-if="blockStats" class="text-sm text-text-secondary">
				{{
					t('dashboard.send.blocks.index.blockCount', { count: blockStats.total }, blockStats.total)
				}}
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
				:placeholder="t('dashboard.send.blocks.index.searchPlaceholder')"
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
							<p class="text-text-secondary text-sm">
								{{ t('dashboard.send.blocks.index.loading') }}
							</p>
						</div>
					</div>
				</template>

				<!-- Empty State (no organization) -->
				<UiEmptyState
					v-if="!hasActiveOrganization"
					icon="lucide:blocks"
					:title="t('dashboard.send.blocks.index.noWorkspaceTitle')"
					:description="t('dashboard.send.blocks.index.noWorkspaceDescription')"
				/>

				<!-- Empty State (no blocks) -->
				<UiEmptyState
					v-else-if="!isLoading && (!blocks || blocks.length === 0) && !debouncedSearch"
					icon="lucide:blocks"
					:title="t('dashboard.send.blocks.index.emptyTitle')"
					:description="t('dashboard.send.blocks.index.emptyDescription')"
				>
					<template #action>
						<UiButton @click="openCreateModal">
							<template #iconLeft>
								<Icon name="lucide:plus" class="w-4 h-4" />
							</template>
							{{ t('dashboard.send.blocks.index.createBlock') }}
						</UiButton>
					</template>
				</UiEmptyState>

				<!-- Empty State (no search results) -->
				<UiEmptyState
					v-else-if="!isLoading && (!blocks || blocks.length === 0) && debouncedSearch"
					icon="lucide:search"
					:title="t('dashboard.send.blocks.index.noResultsTitle')"
					:description="
						t('dashboard.send.blocks.index.noResultsDescription', { query: debouncedSearch })
					"
				>
					<template #action>
						<UiButton
							variant="secondary"
							@click="
								searchQuery = '';
								debouncedSearch = '';
							"
						>
							{{ t('dashboard.send.blocks.index.clearSearch') }}
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
									:title="t('dashboard.send.blocks.index.editContent')"
									@click.stop="navigateToEditPage(block._id)"
								>
									<Icon name="lucide:file-edit" class="w-4 h-4" />
								</button>
								<button
									class="p-2 rounded-lg bg-bg-elevated text-text-primary hover:bg-brand hover:text-text-inverse transition-colors"
									:title="t('dashboard.send.blocks.index.quickSettings')"
									@click.stop="openEditModal(block)"
								>
									<Icon name="lucide:settings" class="w-4 h-4" />
								</button>
								<button
									class="p-2 rounded-lg bg-bg-elevated text-text-primary hover:bg-brand hover:text-text-inverse transition-colors"
									:title="t('common.duplicate')"
									@click.stop="handleDuplicate(block._id)"
								>
									<Icon name="lucide:copy" class="w-4 h-4" />
								</button>
								<button
									class="p-2 rounded-lg bg-bg-elevated text-text-primary hover:bg-error hover:text-text-inverse transition-colors"
									:title="t('common.delete')"
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
										{{ block.description || t('dashboard.send.blocks.index.noDescription') }}
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
										{{ t('dashboard.send.blocks.index.editContent') }}
									</UiDropdownMenuItem>
									<UiDropdownMenuItem icon="lucide:settings" @click="openEditModal(block)">
										{{ t('common.settings') }}
									</UiDropdownMenuItem>
									<UiDropdownMenuItem icon="lucide:copy" @click="handleDuplicate(block._id)">
										{{ t('common.duplicate') }}
									</UiDropdownMenuItem>
									<UiDropdownDivider />
									<UiDropdownMenuItem
										icon="lucide:trash-2"
										danger
										@click="openDeleteModal(block._id, block.name, block.usageCount)"
									>
										{{ t('common.delete') }}
									</UiDropdownMenuItem>
								</UiDropdownMenu>
							</div>

							<!-- Meta Info -->
							<div class="flex items-center gap-2 mt-3">
								<span
									v-if="block.blockCount && block.blockCount > 1"
									class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-brand/10 text-brand"
								>
									{{ t('dashboard.send.blocks.index.blocksBadge', { count: block.blockCount }) }}
								</span>
								<span
									class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-bg-surface text-text-tertiary"
								>
									<Icon name="lucide:bar-chart" class="w-3 h-3" />
									{{ t('dashboard.send.blocks.index.usesBadge', { count: block.usageCount }) }}
								</span>
							</div>

							<p class="text-xs text-text-tertiary mt-3">
								{{
									t('dashboard.send.blocks.index.updatedAt', { date: formatDate(block.updatedAt) })
								}}
							</p>
						</div>
					</UiCard>
				</div>
			</UiQueryBoundary>
		</div>

		<!-- Create Modal -->
		<UiModal
			v-model:open="isCreateModalOpen"
			:title="t('dashboard.send.blocks.index.createBlock')"
			:persistent="isCreating"
		>
			<form @submit.prevent="handleCreate">
				<!-- Name Field -->
				<UiInput
					id="block-name"
					v-model="createForm.name"
					type="text"
					:label="t('common.name')"
					required
					:placeholder="t('dashboard.send.blocks.index.namePlaceholder')"
					:error="createFormErrors.name"
					:disabled="isCreating"
					class="mb-4"
				/>

				<!-- Description Field -->
				<UiTextarea
					id="block-description"
					v-model="createForm.description"
					:label="t('common.description')"
					:rows="2"
					:placeholder="t('dashboard.send.blocks.index.descriptionPlaceholder')"
					:disabled="isCreating"
					class="mb-4"
				/>
			</form>

			<template #footer>
				<UiButton variant="secondary" :disabled="isCreating" @click="closeCreateModal">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton :loading="isCreating" @click="handleCreate">
					{{
						isCreating
							? t('dashboard.send.blocks.index.creating')
							: t('dashboard.send.blocks.index.createBlock')
					}}
				</UiButton>
			</template>
		</UiModal>

		<!-- Edit Modal -->
		<UiModal
			v-model:open="isEditModalOpen"
			:title="t('dashboard.send.blocks.index.editBlock')"
			:persistent="isEditing"
		>
			<form @submit.prevent="handleEdit">
				<!-- Name Field -->
				<UiInput
					id="edit-block-name"
					v-model="editForm.name"
					type="text"
					:label="t('common.name')"
					required
					:placeholder="t('dashboard.send.blocks.index.namePlaceholder')"
					:error="editFormErrors.name"
					:disabled="isEditing"
					class="mb-4"
				/>

				<!-- Description Field -->
				<UiTextarea
					id="edit-block-description"
					v-model="editForm.description"
					:label="t('common.description')"
					:rows="2"
					:placeholder="t('dashboard.send.blocks.index.descriptionPlaceholder')"
					:disabled="isEditing"
					class="mb-4"
				/>
			</form>

			<template #footer>
				<UiButton variant="secondary" :disabled="isEditing" @click="closeEditModal">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton :loading="isEditing" @click="handleEdit">
					{{
						isEditing
							? t('dashboard.send.blocks.index.savingChanges')
							: t('dashboard.send.blocks.index.saveChanges')
					}}
				</UiButton>
			</template>
		</UiModal>

		<!-- Delete Confirmation Modal -->
		<UiModal
			v-model:open="isDeleteModalOpen"
			:title="t('dashboard.send.blocks.index.deleteBlock')"
			:persistent="isDeleting"
		>
			<div class="flex items-start gap-4">
				<div class="p-3 rounded-full bg-error/10 shrink-0 flex items-center justify-center">
					<Icon name="lucide:trash-2" class="w-6 h-6 text-error" />
				</div>
				<div>
					<I18nT
						keypath="dashboard.send.blocks.index.deleteConfirmQuestion"
						tag="p"
						class="text-text-primary"
						scope="global"
					>
						<template #name>
							<span class="font-semibold">"{{ blockToDelete?.name }}"</span>
						</template>
					</I18nT>
					<p class="text-sm text-text-secondary mt-2">
						{{ t('dashboard.send.blocks.index.deleteIrreversible') }}
					</p>
					<p v-if="blockToDelete && blockToDelete.usageCount > 0" class="text-sm text-warning mt-2">
						{{
							t(
								'dashboard.send.blocks.index.deleteUsageWarning',
								{ count: blockToDelete.usageCount },
								blockToDelete.usageCount
							)
						}}
					</p>
				</div>
			</div>

			<template #footer>
				<UiButton variant="secondary" :disabled="isDeleting" @click="closeDeleteModal">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton variant="danger" :loading="isDeleting" @click="handleDelete">
					{{
						isDeleting
							? t('dashboard.send.blocks.index.deleting')
							: t('dashboard.send.blocks.index.deleteBlock')
					}}
				</UiButton>
			</template>
		</UiModal>
	</div>
</template>
