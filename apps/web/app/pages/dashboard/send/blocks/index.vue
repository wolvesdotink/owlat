<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import { useListPage, type ListSortOption } from '~/composables/useListPage';

type BlockRow = FunctionReturnType<typeof api.emailBlocks.blocks.list>[number];

const { t } = useI18n();

useHead({ title: () => t('dashboard.send.blocks.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();

const { hasActiveOrganization, isLoading: teamLoading } = useOrganizationContext();
// Reusable blocks are templates as far as authorization goes: create, update,
// duplicate and remove all require `templates:manage` (owner/admin) —
// `apps/api/convex/emailBlocks/blocks.ts`. The library stays browsable.
const { can, showGateFor } = usePermissions();
const canManage = computed(() => can('templates:manage'));
const showManageGate = computed(() => showGateFor('templates:manage'));

// Sort runs server-side: the list query reads the selected option.
const BLOCK_SORT_OPTIONS = [
	{ value: 'recent', label: 'dashboard.send.blocks.index.sort.recent' },
	{ value: 'mostUsed', label: 'dashboard.send.blocks.index.sort.mostUsed' },
	{ value: 'name', label: 'dashboard.send.blocks.index.sort.name' },
] as const satisfies readonly ListSortOption[];

const { showToast } = useToast();

const { run: duplicateBlock } = useBackendOperation(api.emailBlocks.blocks.duplicate, {
	label: () => t('dashboard.send.blocks.index.duplicateOperation'),
});
const { run: deleteBlock } = useBackendOperation(api.emailBlocks.blocks.remove, {
	label: () => t('dashboard.send.blocks.index.deleteOperation'),
});
const { run: createBlock } = useBackendOperation(api.emailBlocks.blocks.create, {
	label: () => t('dashboard.send.blocks.index.createOperation'),
});

const isCreateModalOpen = ref(false);
const isEditModalOpen = ref(false);

// `reactive` unwraps the composable's refs, so the template reads `list.searchQuery`.
const list = reactive(
	useListPage<(typeof BLOCK_SORT_OPTIONS)[number], BlockRow>({
		sortOptions: BLOCK_SORT_OPTIONS,
		onDelete: async (block) => {
			const result = await deleteBlock({ blockId: block._id });
			if (result.ok) showToast(t('dashboard.send.blocks.index.deletedToast'));
			return result.ok;
		},
		onNew: () => openCreateModal(),
		canCreate: () => canManage.value,
		isBusy: () => isCreateModalOpen.value || isEditModalOpen.value,
	})
);

// Real-time list, skipped until the session has an active organization.
const {
	data: blocks,
	isLoading: blocksLoading,
	error: blocksError,
	refetch: refetchBlocks,
} = useOrganizationQuery(api.emailBlocks.blocks.list, () => ({
	search: list.debouncedSearch || undefined,
	sortBy: list.currentSort.value,
}));

const { data: blockStats } = useOrganizationQuery(api.emailBlocks.blocks.getStatsByTeam);

const isLoading = computed(() => teamLoading.value || blocksLoading.value);
const isEmpty = computed(() => !blocks.value || blocks.value.length === 0);

const handleDuplicate = async (block: BlockRow) => {
	const result = await duplicateBlock({ blockId: block._id });
	if (result.ok) showToast(t('dashboard.send.blocks.index.duplicatedToast'));
};

// Create new block modal
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
		if (!blockId.ok) return;

		closeCreateModal();
		// Navigate directly to the editor to add content
		router.push(`/dashboard/send/blocks/${blockId.result}/edit`);
	} finally {
		isCreating.value = false;
	}
};

// Quick-settings modal: name and description (content has its own editor page)
const blockToEdit = ref<Id<'emailBlocks'> | null>(null);
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

const openEditModal = (block: BlockRow) => {
	blockToEdit.value = block._id;
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
			blockId: blockToEdit.value,
			name: editForm.name.trim(),
			description: editForm.description.trim() || undefined,
		});
		if (!result.ok) return;

		showToast(t('dashboard.send.blocks.index.updatedToast'));
		closeEditModal();
	} finally {
		isEditing.value = false;
	}
};

// Navigate to the full edit page for content editing
const navigateToEditPage = (block: BlockRow) => {
	router.push(`/dashboard/send/blocks/${block._id}/edit`);
};
</script>

<template>
	<ListPageShell
		v-model:search="list.searchQuery"
		layout="grid"
		:title="t('dashboard.send.blocks.index.title')"
		:description="t('dashboard.send.blocks.index.subtitle')"
		:loading="isLoading && !blocks"
		:error="blocksError"
		:error-title="t('dashboard.send.blocks.index.loadError')"
		:loading-label="t('dashboard.send.blocks.index.loading')"
		:has-organization="hasActiveOrganization"
		:is-empty="isEmpty"
		:active-search="list.debouncedSearch"
		:search-placeholder="t('common.filterPlaceholder')"
		:sort-options="list.sortOptions"
		:sort="list.currentSort.value"
		:sort-label="t('dashboard.send.blocks.index.sortLabel')"
		sort-listbox-id="blocks-sort-listbox"
		:empty-no-org="{
			icon: 'lucide:blocks',
			title: t('dashboard.send.blocks.index.noWorkspaceTitle'),
			description: t('dashboard.send.blocks.index.noWorkspaceDescription'),
		}"
		:empty="{
			icon: 'lucide:blocks',
			title: t('dashboard.send.blocks.index.emptyTitle'),
			description: t('dashboard.send.blocks.index.emptyDescription'),
		}"
		:no-results="{
			title: t('dashboard.send.blocks.index.noResultsTitle'),
			description: t('dashboard.send.blocks.index.noResultsDescription', {
				query: list.debouncedSearch,
			}),
		}"
		:delete-copy="{
			title: t('dashboard.send.blocks.index.deleteBlock'),
			confirmKeypath: 'dashboard.send.blocks.index.deleteConfirmQuestion',
			description: t('dashboard.send.blocks.index.deleteIrreversible'),
			confirmText: t('dashboard.send.blocks.index.deleteBlock'),
		}"
		:delete-open="list.isDeleteOpen"
		:delete-name="list.deleteTarget?.name"
		:is-deleting="list.isDeleting"
		@update:sort="list.selectSort"
		@retry="refetchBlocks"
		@clear-search="list.clearSearch"
		@confirm-delete="list.confirmDelete"
		@cancel-delete="list.closeDelete"
	>
		<template #actions>
			<UiButton v-if="canManage" size="sm" @click="openCreateModal">
				<template #iconLeft>
					<Icon name="lucide:plus" class="w-4 h-4" />
				</template>
				{{ t('dashboard.send.blocks.index.newBlock') }}
			</UiButton>
			<p v-else-if="showManageGate" class="text-xs text-text-tertiary">
				{{ t('dashboard.send.blocks.index.adminsOnly') }}
			</p>
		</template>

		<template #filters>
			<p v-if="blockStats" class="text-sm text-text-secondary">
				{{
					t('dashboard.send.blocks.index.blockCount', { count: blockStats.total }, blockStats.total)
				}}
			</p>
		</template>

		<template v-if="canManage" #empty-action>
			<UiButton @click="openCreateModal">
				<template #iconLeft>
					<Icon name="lucide:plus" class="w-4 h-4" />
				</template>
				{{ t('dashboard.send.blocks.index.createBlock') }}
			</UiButton>
		</template>

		<template #grid>
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
				<SendBlockCard
					v-for="block in blocks"
					:key="block._id"
					:block="block"
					:can-manage="canManage"
					@open="navigateToEditPage"
					@settings="openEditModal"
					@duplicate="handleDuplicate"
					@delete="list.openDelete"
				/>
			</div>
		</template>

		<template #delete-extra>
			<p
				v-if="list.deleteTarget && list.deleteTarget.usageCount > 0"
				class="text-sm text-warning mt-2"
			>
				{{
					t(
						'dashboard.send.blocks.index.deleteUsageWarning',
						{ count: list.deleteTarget.usageCount },
						list.deleteTarget.usageCount
					)
				}}
			</p>
		</template>

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
	</ListPageShell>
</template>
