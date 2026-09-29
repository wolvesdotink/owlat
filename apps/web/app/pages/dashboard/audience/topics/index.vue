<script setup lang="ts">
import { api } from '@owlat/api';

const { t } = useI18n();

useHead({ title: () => t('dashboard.audience.topics.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Get the current user's organization
const { hasActiveOrganization, isLoading: organizationLoading } = useOrganizationContext();
// Creating, editing and deleting a topic all require `topics:manage`
// (owner/admin) on the backend — `apps/api/convex/topics/topics.ts`. The list
// itself is readable by every member, so only the write actions come off for an
// editor, with a line saying why rather than a silent absence.
const { can, showGateFor } = usePermissions();
const canManage = computed(() => can('topics:manage'));
const showManageGate = computed(() => showGateFor('topics:manage'));

// The list sorts and filters client-side, so every page is pulled: otherwise a
// client sort would only reorder the loaded rows and an org with more topics
// than one page would be capped.
const {
	results: topics,
	isLoading: topicsLoading,
	error: topicsError,
	refetch: refetchTopics,
} = useLoadAllPages(
	useOrganizationPaginatedQuery(api.topics.topics.list, undefined, { initialNumItems: 50 }),
	50
);

const isLoading = computed(() => organizationLoading.value || topicsLoading.value);

// Data table controls (search and sort) — shared contract with the other
// audience list pages: identical debounced search + sort affordance.
type SortField = 'name' | 'contactCount' | 'createdAt';
const { searchQuery, debouncedSearch, clearSearch, sortBy, sortOrder, toggleSort, getSortIcon } =
	useDataTable<SortField>({
		defaultSort: 'createdAt',
		defaultOrder: 'desc',
		sortableFields: ['name', 'contactCount', 'createdAt'],
	});

// Filtered and sorted topics (client-side over the fully-loaded set)
const filteredTopics = computed(() => {
	const query = debouncedSearch.value.toLowerCase();
	const items = query
		? topics.value.filter(
				(topic) =>
					topic.name.toLowerCase().includes(query) ||
					(topic.description && topic.description.toLowerCase().includes(query))
			)
		: [...topics.value];

	return items.sort((a, b) => {
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
});

const {
	isTopicModalOpen,
	isEditMode,
	topicForm,
	topicErrors,
	isSaving,
	openCreateModal,
	openEditModal,
	closeTopicModal,
	handleSave,
	isDeleteModalOpen,
	deleteTarget,
	isDeleting,
	openDeleteModal,
	closeDeleteModal,
	handleDelete,
} = useTopicForm();

const deleteDescription = computed(() => {
	const irreversible = t('dashboard.audience.topics.index.deleteModal.irreversible');
	const count = deleteTarget.value?.contactCount ?? 0;
	if (count === 0) return irreversible;
	const kept = t('dashboard.audience.topics.index.deleteModal.contactsKept', { count }, count);
	return `${irreversible} ${kept}`;
});

// Props shared by the table and the mobile card list; `ListPageShell` mounts one.
const listTable = computed(() => ({
	items: filteredTopics.value,
	icon: 'lucide:list',
	itemTo: (topic: { _id: string }) => `/dashboard/audience/topics/${topic._id}`,
	countOf: (topic: { contactCount: number }) => topic.contactCount,
	countField: 'contactCount' as const,
	countHeader: t('dashboard.audience.topics.index.table.contacts'),
	createdHeader: t('dashboard.audience.topics.index.table.created'),
	totalText: t(
		'dashboard.audience.topics.index.count',
		{ count: filteredTopics.value.length },
		filteredTopics.value.length
	),
	editLabel: t('dashboard.audience.topics.index.actions.edit'),
	deleteLabel: t('dashboard.audience.topics.index.actions.delete'),
	canManage: canManage.value,
	getSortIcon,
	onSort: toggleSort,
	onEdit: openEditModal,
	onDelete: openDeleteModal,
}));

// Auto-open the Create Topic modal when arriving via the audience overview
// quick-action link (/dashboard/audience/topics?action=create).
const route = useRoute();
onMounted(() => {
	// Same guard the contacts list puts on its own `?action=add` link: the hub
	// card is a create button like any other, so a caller who cannot create must
	// not land on a modal whose submit would 403.
	if (canManage.value && route.query['action'] === 'create') {
		openCreateModal();
	}
});
</script>

<template>
	<ListPageShell
		v-model:search="searchQuery"
		:title="t('dashboard.audience.topics.index.title')"
		:description="t('dashboard.audience.topics.index.subtitle')"
		:loading="isLoading && topics.length === 0"
		:error="topicsError"
		:error-title="t('dashboard.audience.topics.index.errorTitle')"
		:has-organization="hasActiveOrganization"
		:is-empty="filteredTopics.length === 0"
		:active-search="debouncedSearch"
		:search-placeholder="t('dashboard.audience.topics.index.searchPlaceholder')"
		:empty-no-org="{
			icon: 'lucide:list',
			title: t('dashboard.audience.topics.index.noWorkspace.title'),
			description: t('dashboard.audience.topics.index.noWorkspace.description'),
		}"
		:empty="{
			icon: 'lucide:list',
			title: t('dashboard.audience.topics.index.empty.title'),
			description: t('dashboard.audience.topics.index.empty.description'),
		}"
		:no-results="{
			title: t('dashboard.audience.topics.index.noResults.title'),
			description: t('dashboard.audience.topics.index.noResults.description', {
				query: debouncedSearch,
			}),
		}"
		:delete-copy="{
			title: t('dashboard.audience.topics.index.deleteModal.title'),
			confirmKeypath: 'dashboard.audience.topics.index.deleteModal.body',
			description: deleteDescription,
			confirmText: t('dashboard.audience.topics.index.deleteModal.title'),
		}"
		:delete-open="isDeleteModalOpen"
		:delete-name="deleteTarget?.name"
		:is-deleting="isDeleting"
		@retry="refetchTopics"
		@clear-search="clearSearch"
		@confirm-delete="handleDelete"
		@cancel-delete="closeDeleteModal"
	>
		<template #before-header>
			<AudienceTabs />
		</template>

		<template #actions>
			<UiButton v-if="canManage" @click="openCreateModal">
				<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
				{{ t('dashboard.audience.topics.index.newTopic') }}
			</UiButton>
			<p v-else-if="showManageGate" class="text-xs text-text-tertiary">
				{{ t('dashboard.audience.topics.index.adminsOnly') }}
			</p>
		</template>

		<template #loading>
			<DashboardListSkeleton variant="table" :columns="6" :rows="6" />
		</template>

		<template v-if="canManage" #empty-action>
			<UiButton @click="openCreateModal">
				<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
				{{ t('dashboard.audience.topics.index.newTopic') }}
			</UiButton>
		</template>

		<template #table>
			<AudienceListTable v-bind="listTable" layout="table" />
		</template>

		<template #cards>
			<AudienceListTable v-bind="listTable" layout="cards" />
		</template>

		<!-- Create / edit topic -->
		<UiModal
			v-model:open="isTopicModalOpen"
			:title="
				isEditMode
					? t('dashboard.audience.topics.index.editModal.title')
					: t('dashboard.audience.topics.index.createModal.title')
			"
		>
			<form id="topic-form" novalidate @submit.prevent="handleSave">
				<div
					v-if="topicErrors.general"
					class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20"
				>
					<p class="text-sm text-error">{{ topicErrors.general }}</p>
				</div>

				<div class="mb-4">
					<UiInput
						v-model="topicForm.name"
						:label="t('common.name')"
						:required="true"
						:placeholder="t('dashboard.audience.topics.index.form.namePlaceholder')"
						:error="topicErrors.name"
						:disabled="isSaving"
					/>
				</div>

				<div class="mb-4">
					<UiTextarea
						v-model="topicForm.description"
						:label="t('common.description')"
						:rows="3"
						:placeholder="t('dashboard.audience.topics.index.form.descriptionPlaceholder')"
						:disabled="isSaving"
					/>
				</div>

				<div class="mb-6">
					<UiCheckbox
						v-model="topicForm.requireDoubleOptIn"
						:label="t('dashboard.audience.topics.index.form.doiLabel')"
						:description="t('dashboard.audience.topics.index.form.doiDescription')"
						:disabled="isSaving"
					/>
				</div>
			</form>

			<template #footer>
				<UiButton variant="secondary" :disabled="isSaving" @click="closeTopicModal">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton type="submit" form="topic-form" :loading="isSaving">
					<template v-if="isEditMode">
						{{ isSaving ? t('common.saving') : t('dashboard.audience.topics.index.saveChanges') }}
					</template>
					<template v-else>
						{{
							isSaving
								? t('dashboard.audience.topics.index.creating')
								: t('dashboard.audience.topics.index.createModal.title')
						}}
					</template>
				</UiButton>
			</template>
		</UiModal>
	</ListPageShell>
</template>
