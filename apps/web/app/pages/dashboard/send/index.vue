<script setup lang="ts">
/**
 * Templates: one list of every email template, whatever its type, with
 * search, sort, the grid/list switch and duplicate/delete on each row.
 *
 * Saved blocks and the media library are tabs beside it (`SendTabs`). One
 * "New template" button: no stat tiles, quick actions or "recent" cards with
 * create buttons of their own.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import type { BackendOperationResult } from '~/composables/useBackendOperation';
import { useMarketingDeleteUndo } from '~/composables/useMarketingDeleteUndo';
import { useTemplateList } from '~/composables/useTemplateList';
import { formatDate } from '~/utils/formatters';
import {
	TEMPLATE_TYPE_FILTERS,
	parseTemplateTypeFilter,
	type TemplateTypeFilter,
} from '~/utils/templateListFilter';
import { FileTextIcon, MailIcon, PlusIcon } from '@coolicons/vue';
import SendTemplateStatusBadge from '~/components/send/TemplateStatusBadge.vue';

type TemplateRow = FunctionReturnType<typeof api.emailTemplates.emails.list>['page'][number];

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.send.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const route = useRoute();
const router = useRouter();
// Creating, duplicating and deleting a template all require `templates:manage`
// (owner/admin) on the backend — `apps/api/convex/emailTemplates/emails.ts`.
// Browsing and opening one stays open to every member; the writes do not.
const { can, showGateFor, isAdmin } = usePermissions();
const { isEnabled } = useFeatureFlag();
const canManage = computed(() => can('templates:manage'));
const showManageGate = computed(() => showGateFor('templates:manage'));
const { showToast } = useToast();

const { data: typeCounts } = useOrganizationQuery(
	api.emailTemplates.organization.countByTypeByOrganization
);

// The create flow only makes marketing templates, so a transactional-typed one
// exists only when someone changed a template's type in its settings. Until
// then the filter would separate nothing, so it stays hidden and the list is
// unfiltered even under a stale `?type=` link. While the counts load, the URL
// is trusted, so a filtered link does not query twice.
const showTypeFilter = computed(() => (typeCounts.value?.['transactional'] ?? 0) > 0);

// The filter lives in the URL (`?type=marketing`), so a filtered list can be
// linked to and survives a reload.
const typeFilter = computed<TemplateTypeFilter>({
	get: () =>
		typeCounts.value && !showTypeFilter.value
			? 'all'
			: parseTemplateTypeFilter(route.query['type']),
	set: (value) => {
		void router.replace({ query: { ...route.query, type: value === 'all' ? undefined : value } });
	},
});

// A template's type is only a label: the campaign and automation pickers list
// marketing templates, and the transactional API sends `transactionalEmails`,
// never a template. So the Transactional filter says where the API-triggered
// emails actually are, to whoever can open that list: an admin with the
// `transactional` flag on, the same rule as the navigation's gate. Spelled out
// here because importing the navigation table would load it, its icons and the
// settings registry with this page.
const showTransactionalHint = computed(
	() =>
		showTypeFilter.value &&
		typeFilter.value === 'transactional' &&
		isAdmin.value &&
		isEnabled('transactional')
);

function countFor(filter: TemplateTypeFilter): number | null {
	const counts = typeCounts.value;
	if (!counts) return null;
	if (filter === 'all') return counts['total'] ?? 0;
	return counts[filter] ?? 0;
}

// The same segmented tabs as the Campaigns list: label + count.
const filterOptions = computed(() =>
	TEMPLATE_TYPE_FILTERS.map((filter) => {
		const count = countFor(filter);
		return {
			value: filter,
			label: t(`dashboard.send.index.filters.${filter}`),
			count: count === null ? null : count.toLocaleString(locale.value),
		};
	})
);

// Every template type opens in the same email editor.
function editPath(id: Id<'emailTemplates'>): string {
	return `/dashboard/send/emails/${id}/edit`;
}

const { run: duplicateTemplate } = useBackendOperation(api.emailTemplates.emails.duplicate, {
	label: () => t('dashboard.send.index.operations.duplicate'),
});
const { run: deleteTemplate } = useBackendOperation(api.emailTemplates.emails.remove, {
	label: () => t('dashboard.send.index.operations.delete'),
});
const { run: restoreTemplate } = useBackendOperation(api.emailTemplates.emails.restore, {
	label: () => t('dashboard.send.index.operations.restore'),
});
const { deleteWithUndo } = useMarketingDeleteUndo();
const { run: createTemplate } = useBackendOperation(api.emailTemplates.emails.create, {
	label: () => t('dashboard.send.index.createOperation'),
});
const { run: createFromPreset } = useBackendOperation(
	api.emailTemplates.organization.createFromPreset,
	{ label: () => t('dashboard.send.index.createOperation') }
);

const isLibraryOpen = ref(false);
const libraryRef = ref<{
	handleCreate: (
		createTemplate: (args: {
			name: string;
			type: 'marketing' | 'transactional';
		}) => Promise<BackendOperationResult<Id<'emailTemplates'>>>,
		createFromPreset: (args: {
			name: string;
			subject: string;
			content: string;
			type: 'marketing' | 'transactional';
		}) => Promise<BackendOperationResult<Id<'emailTemplates'>>>
	) => Promise<void>;
	isCreating: boolean;
} | null>(null);

// The list query is built inside `useTemplateList`; its pager is kept here for
// Load more.
let pager: { status: { readonly value: string }; loadMore: (numItems: number) => void } | undefined;

// `reactive` unwraps the composable's refs, so the template reads `list.items`.
const list = reactive(
	useTemplateList<TemplateRow>({
		// Type filter, search and sort all run on the server, before pagination.
		// A search is relevance-ordered (its index cannot sort), so it sends no
		// sort and the menu says so. A blank term is no search: the server trims
		// it and browses. A new sort is new args: the subscription
		// starts over from the first page, with nothing on screen until it lands,
		// so the old order never shows under the new label.
		query: ({ search, sort }) => {
			const { results, status, loadMore, isLoading, error, refetch } =
				useOrganizationPaginatedQuery(
					api.emailTemplates.emails.list,
					() => ({
						...(typeFilter.value === 'all' ? {} : { type: typeFilter.value }),
						...(search.value.trim()
							? { search: search.value }
							: { sortBy: sort.value.sortBy, sortOrder: sort.value.sortOrder }),
					}),
					{ initialNumItems: 50 }
				);
			pager = { status, loadMore };
			return { rows: results, isLoading, error, refetch };
		},
		defaultViewMode: 'grid',
		editPath: (template) => editPath(template._id),
		onDuplicate: async (template) => {
			const result = await duplicateTemplate({ templateId: template._id });
			if (result.ok) showToast(t('dashboard.send.index.toasts.duplicated'));
		},
		// A delete runs at once (the template goes to Recently deleted) and the
		// toast offers Undo.
		confirmDelete: false,
		onDelete: (template) =>
			deleteWithUndo({
				name: template.name,
				remove: async () => (await deleteTemplate({ templateId: template._id })).ok,
				restore: () => restoreTemplate({ templateId: template._id }),
			}),
		onNew: () => (isLibraryOpen.value = true),
		canCreate: () => canManage.value,
		isBusy: () => isLibraryOpen.value,
		onEscape: () => {
			if (!isLibraryOpen.value || libraryRef.value?.isCreating) return false;
			isLibraryOpen.value = false;
			return true;
		},
	})
);

const canLoadMore = computed(() => list.items.length > 0 && pager?.status.value === 'CanLoadMore');

async function handleCreateSubmit() {
	await libraryRef.value?.handleCreate(createTemplate, createFromPreset);
}

function handleCreated(templateId: Id<'emailTemplates'>) {
	void router.push(editPath(templateId));
}
</script>

<template>
	<ListPageShell
		v-model:search="list.searchQuery"
		v-model:view-mode="list.viewMode"
		:title="t('dashboard.send.index.title')"
		:description="t('dashboard.send.index.subtitle')"
		:loading="list.isLoading"
		:error="list.error"
		:error-title="t('dashboard.send.index.loadError')"
		:loading-label="t('dashboard.send.index.loadingTemplates')"
		:has-organization="list.hasOrganization"
		:is-empty="list.isEmpty"
		:active-search="list.debouncedSearch"
		:search-placeholder="t('dashboard.send.index.searchPlaceholder')"
		:sort-options="list.sortOptions"
		:sort="list.currentSort.value"
		:sort-label="t('dashboard.send.index.sortLabel')"
		sort-listbox-id="templates-sort-listbox"
		:sort-disabled-label="
			list.debouncedSearch.trim() ? t('dashboard.send.index.sortedByRelevance') : undefined
		"
		:empty-no-org="{
			icon: MailIcon,
			title: t('dashboard.send.index.emptyNoTeam.title'),
			description: t('dashboard.send.index.emptyNoTeam.description'),
		}"
		:empty="{
			icon: FileTextIcon,
			title:
				typeFilter === 'all'
					? t('dashboard.send.index.empty.title')
					: t(`dashboard.send.index.empty.filtered.${typeFilter}`),
			description: canManage ? t('dashboard.send.index.empty.description') : '',
		}"
		:no-results="{
			title: t('dashboard.send.index.noResults.title'),
			description: t('dashboard.send.index.noResults.description', {
				query: list.debouncedSearch,
			}),
		}"
		@update:sort="list.selectSort"
		@retry="list.refetch"
		@clear-search="list.clearSearch"
	>
		<template #before-header>
			<SendTabs />
		</template>

		<template #actions>
			<UiButton v-if="canManage" size="sm" data-testid="new-template" @click="isLibraryOpen = true">
				<template #iconLeft><PlusIcon class="w-4 h-4" /></template>
				{{ t('dashboard.send.index.newTemplate') }}
			</UiButton>
			<p v-else-if="showManageGate" class="text-xs text-text-tertiary">
				{{ t('dashboard.send.index.adminsOnly') }}
			</p>
		</template>

		<template v-if="showTransactionalHint" #after-header>
			<I18nT
				keypath="dashboard.send.index.transactionalTypeHint"
				tag="p"
				scope="global"
				class="max-w-2xl text-xs text-text-tertiary"
				data-testid="template-transactional-hint"
			>
				<template #link>
					<NuxtLink
						to="/dashboard/send/transactional"
						class="text-text-secondary underline hover:text-text-primary"
						>{{ t('dashboard.send.index.transactionalTypeHintLink') }}</NuxtLink
					>
				</template>
			</I18nT>
		</template>

		<template #filters>
			<!-- A wrapper that scrolls, so a narrow phone scrolls the strip sideways
			     instead of squeezing its segments; the control keeps its natural width. -->
			<div
				v-if="showTypeFilter"
				class="max-w-full overflow-x-auto"
				data-testid="template-type-filter"
			>
				<UiSegmentedControl
					:model-value="typeFilter"
					:options="filterOptions"
					:aria-label="t('dashboard.send.index.typeFilterLabel')"
					fit="content"
					class="w-max"
					@update:model-value="typeFilter = parseTemplateTypeFilter($event)"
				>
					<template v-for="option in filterOptions" :key="option.value" #[`option-${option.value}`]>
						{{ option.label }}
						<span v-if="option.count !== null" class="tabular-nums text-text-tertiary">
							{{ option.count }}
						</span>
					</template>
				</UiSegmentedControl>
			</div>
		</template>

		<template #grid>
			<SendTemplateGrid
				:items="list.items"
				:can-manage="canManage"
				@edit="list.handleEdit"
				@duplicate="list.handleDuplicate"
				@delete="list.openDelete"
			>
				<template #meta="{ item }">
					<!-- Marketing is the default type; only the exception gets a badge -->
					<span
						v-if="item.type !== 'marketing'"
						class="text-xs px-1.5 py-0.5 rounded bg-info-subtle text-info"
					>
						{{ t(`dashboard.send.index.templateTypes.${item.type}`) }}
					</span>
				</template>
			</SendTemplateGrid>
		</template>

		<template #table>
			<SendTemplateTable
				:items="list.items"
				:columns="[
					t('common.name'),
					t('dashboard.send.index.columns.subject'),
					t('common.status'),
					t('dashboard.send.index.columns.updated'),
				]"
				:can-manage="canManage"
				@edit="list.handleEdit"
				@duplicate="list.handleDuplicate"
				@delete="list.openDelete"
			>
				<template #cells="{ item }">
					<td class="px-6 py-4">
						<span class="text-text-primary font-medium">{{ item.name }}</span>
						<span
							v-if="item.type !== 'marketing'"
							class="ml-2 text-xs px-1.5 py-0.5 rounded bg-info-subtle text-info"
						>
							{{ t(`dashboard.send.index.templateTypes.${item.type}`) }}
						</span>
					</td>
					<td class="px-6 py-4">
						<span class="text-text-secondary">{{
							item.subject || t('shared.templateList.noSubject')
						}}</span>
					</td>
					<td class="px-6 py-4">
						<SendTemplateStatusBadge :status="item.status" />
					</td>
					<td class="px-6 py-4">
						<span class="text-text-tertiary text-sm">{{ formatDate(item.updatedAt) }}</span>
					</td>
				</template>
			</SendTemplateTable>
		</template>

		<template #cards>
			<SendTemplateCardList
				:items="list.items"
				:can-manage="canManage"
				@edit="list.handleEdit"
				@duplicate="list.handleDuplicate"
				@delete="list.openDelete"
			>
				<template #meta="{ item }">
					<span
						v-if="item.type !== 'marketing'"
						class="text-xs px-1.5 py-0.5 rounded bg-info-subtle text-info"
					>
						{{ t(`dashboard.send.index.templateTypes.${item.type}`) }}
					</span>
				</template>
			</SendTemplateCardList>
		</template>

		<div v-if="canLoadMore" class="flex justify-center mt-6">
			<UiButton variant="outline" size="sm" @click="pager?.loadMore(50)">
				{{ t('dashboard.send.index.loadMore') }}
			</UiButton>
		</div>

		<LazyMailTemplateLibraryModal
			ref="libraryRef"
			v-model:open="isLibraryOpen"
			@create="handleCreated"
		>
			<template #submit-button="{ isCreating }">
				<UiButton type="submit" :loading="isCreating" @click="handleCreateSubmit">
					{{
						isCreating
							? t('dashboard.send.index.creating')
							: t('dashboard.send.index.createAndEdit')
					}}
				</UiButton>
			</template>
		</LazyMailTemplateLibraryModal>
	</ListPageShell>
</template>
