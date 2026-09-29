<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import type { TemplateRowAction } from '~/composables/useTemplateList';
import { formatNumber } from '~/utils/formatters';

type EmailRow = FunctionReturnType<typeof api.transactional.emails.list>[number];
type StatusFilter = 'all' | EmailRow['status'];

const { t } = useI18n();

useHead({ title: () => t('dashboard.send.transactional.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Transactional emails are templates for authorization: create, duplicate and
// remove all require `templates:manage` (owner/admin) —
// `apps/api/convex/transactional/emails.ts`. The list stays browsable.
const { can, showGateFor } = usePermissions();
const canManage = computed(() => can('templates:manage'));
const showManageGate = computed(() => showGateFor('templates:manage'));
const { showToast } = useToast();

const { run: duplicateEmail } = useBackendOperation(api.transactional.emails.duplicate, {
	label: () => t('dashboard.send.transactional.index.operations.duplicate'),
});
const { run: deleteEmail } = useBackendOperation(api.transactional.emails.remove, {
	label: () => t('dashboard.send.transactional.index.operations.delete'),
});

const isCreateOpen = ref(false);
const snippetEmail = ref<{ name: string; slug: string } | null>(null);
// Recent-sends modal (links through to the per-send delivery timeline)
const recentSends = ref<{ id: Id<'transactionalEmails'>; name: string } | null>(null);
const isRecentSendsOpen = ref(false);

const selectedStatus = ref<StatusFilter>('all');
const statusFilters = computed(() => [
	{ value: 'all', label: t('common.all') },
	{ value: 'draft', label: t('shared.templateList.status.draft') },
	{ value: 'published', label: t('shared.templateList.status.published') },
	{ value: 'pending_review', label: t('shared.templateList.status.pendingReview') },
]);

// `reactive` unwraps the composable's refs, so the template reads `list.items`.
const list = reactive(
	useTemplateList<EmailRow>({
		editPath: (email) => `/dashboard/send/transactional/${email._id}/edit`,
		// Status, search and sort all run server-side.
		query: ({ search, sort }) => {
			const { data, isLoading, error, refetch } = useOrganizationQuery(
				api.transactional.emails.list,
				() => ({
					status: selectedStatus.value === 'all' ? undefined : selectedStatus.value,
					search: search.value || undefined,
					sortBy: sort.value.sortBy,
					sortOrder: sort.value.sortOrder,
				})
			);
			return { rows: data, isLoading, error, refetch };
		},
		onDuplicate: async (email) => {
			const result = await duplicateEmail({ id: email._id });
			if (result.ok) showToast(t('dashboard.send.transactional.index.toasts.duplicated'));
		},
		onDelete: async (email) => {
			const result = await deleteEmail({ id: email._id });
			if (result.ok) showToast(t('dashboard.send.transactional.index.toasts.deleted'));
			return result.ok;
		},
		onNew: () => (isCreateOpen.value = true),
		canCreate: () => canManage.value,
		isBusy: () => isCreateOpen.value || snippetEmail.value !== null || isRecentSendsOpen.value,
	})
);

const { data: statusCounts } = useOrganizationQuery(api.transactional.emails.countByStatus);
const { data: sendCounts } = useOrganizationQuery(api.transactional.sends.getCounts);

const statusCount = (status: string) =>
	statusCounts.value
		? statusCounts.value[status === 'all' ? 'total' : (status as EmailRow['status'])]
		: undefined;

const sendCount = (email: EmailRow) => formatNumber(sendCounts.value?.[email._id] ?? 0);

const rowActions = computed<TemplateRowAction<EmailRow>[]>(() => [
	{
		key: 'api-code',
		icon: 'lucide:code',
		label: t('dashboard.send.transactional.index.viewApiCode'),
		overlay: true,
		inline: true,
		run: (email) => (snippetEmail.value = { name: email.name, slug: email.slug }),
	},
	{
		key: 'sends',
		icon: 'lucide:send',
		label: t('dashboard.send.transactional.index.viewSends'),
		run: (email) => {
			recentSends.value = { id: email._id, name: email.name };
			isRecentSendsOpen.value = true;
		},
	},
]);
</script>

<template>
	<ListPageShell
		v-model:search="list.searchQuery"
		v-model:view-mode="list.viewMode"
		:title="t('dashboard.send.transactional.index.title')"
		:description="t('dashboard.send.transactional.index.subtitle')"
		:loading="list.isLoading"
		:error="list.error"
		:error-title="t('dashboard.send.transactional.index.loadError')"
		:loading-label="t('dashboard.send.transactional.index.loadingEmails')"
		:has-organization="list.hasOrganization"
		:is-empty="list.isEmpty"
		:active-search="list.debouncedSearch"
		:search-placeholder="t('dashboard.send.transactional.index.searchPlaceholder')"
		:sort-options="list.sortOptions"
		:sort="list.currentSort.value"
		:sort-label="t('dashboard.send.transactional.index.sortLabel')"
		sort-listbox-id="transactional-sort-listbox"
		:empty-no-org="{
			icon: 'lucide:send',
			title: t('dashboard.send.transactional.index.emptyNoWorkspace.title'),
			description: t('dashboard.send.transactional.index.emptyNoWorkspace.description'),
		}"
		:empty="{
			icon: 'lucide:send',
			title: t('dashboard.send.transactional.index.empty.title'),
			description: t('dashboard.send.transactional.index.empty.description'),
		}"
		:no-results="{
			title: t('dashboard.send.transactional.index.noResults.title'),
			description: t('dashboard.send.transactional.index.noResults.description', {
				query: list.debouncedSearch,
			}),
		}"
		:delete-copy="{
			title: t('dashboard.send.transactional.index.delete.title'),
			confirmKeypath: 'dashboard.send.transactional.index.delete.confirm',
			description: t('dashboard.send.transactional.index.delete.description'),
			confirmText: t('common.delete'),
		}"
		:delete-open="list.isDeleteOpen"
		:delete-name="list.deleteTarget?.name"
		:is-deleting="list.isDeleting"
		@update:sort="list.selectSort"
		@retry="list.refetch"
		@clear-search="list.clearSearch"
		@confirm-delete="list.confirmDelete"
		@cancel-delete="list.closeDelete"
	>
		<template #actions>
			<UiButton v-if="canManage" size="sm" @click="isCreateOpen = true">
				<template #iconLeft>
					<Icon name="lucide:plus" class="w-4 h-4" />
				</template>
				{{ t('dashboard.send.transactional.index.newEmail') }}
			</UiButton>
			<p v-else-if="showManageGate" class="text-xs text-text-tertiary">
				{{ t('dashboard.send.transactional.index.adminsOnly') }}
			</p>
		</template>

		<template #filters>
			<UiSegmentedControl
				:model-value="selectedStatus"
				:options="statusFilters"
				:aria-label="t('dashboard.send.transactional.index.statusFilterLabel')"
				@update:model-value="selectedStatus = $event as StatusFilter"
			>
				<template v-for="filter in statusFilters" :key="filter.value" #[`option-${filter.value}`]>
					{{ filter.label }}
					<span v-if="statusCount(filter.value) !== undefined" class="text-text-tertiary">
						({{ statusCount(filter.value) }})
					</span>
				</template>
			</UiSegmentedControl>
		</template>

		<template v-if="canManage" #empty-action>
			<UiButton @click="isCreateOpen = true">
				<template #iconLeft>
					<Icon name="lucide:plus" class="w-4 h-4" />
				</template>
				{{ t('dashboard.send.transactional.index.empty.action') }}
			</UiButton>
		</template>

		<template #grid>
			<SendTemplateGrid
				:items="list.items"
				:can-manage="canManage"
				:actions="rowActions"
				@edit="list.handleEdit"
				@duplicate="list.handleDuplicate"
				@delete="list.openDelete"
			>
				<template #thumbnail="{ item }">
					<Icon name="lucide:send" class="w-10 h-10 text-text-tertiary/30 mb-2" />
					<code
						class="px-2 py-1 rounded bg-bg-elevated text-text-tertiary text-xs font-mono truncate max-w-full"
					>
						{{ item.slug }}
					</code>
				</template>
				<template #meta="{ item }">
					<span class="text-text-tertiary text-xs">
						{{ t('dashboard.send.transactional.index.sendCount', { count: sendCount(item) }) }}
					</span>
				</template>
			</SendTemplateGrid>
		</template>

		<template #table>
			<SendTemplateTable
				:items="list.items"
				:columns="[
					t('common.name'),
					t('dashboard.send.transactional.index.columns.slug'),
					t('common.status'),
					t('dashboard.send.transactional.index.columns.sends'),
					t('dashboard.send.transactional.index.columns.updated'),
				]"
				:can-manage="canManage"
				:actions="rowActions"
				@edit="list.handleEdit"
				@duplicate="list.handleDuplicate"
				@delete="list.openDelete"
			>
				<template #cells="{ item }">
					<td class="px-6 py-4">
						<div class="flex flex-col">
							<span class="text-text-primary font-medium">{{ item.name }}</span>
							<span class="text-text-tertiary text-sm">{{
								item.subject || t('shared.templateList.noSubject')
							}}</span>
						</div>
					</td>
					<td class="px-6 py-4">
						<code
							class="px-2 py-1 rounded bg-bg-surface text-text-secondary text-sm font-mono whitespace-nowrap"
						>
							{{ item.slug }}
						</code>
					</td>
					<td class="px-6 py-4">
						<SendTemplateStatusBadge :status="item.status" />
					</td>
					<td class="px-6 py-4">
						<span class="text-text-secondary text-sm tabular-nums">{{ sendCount(item) }}</span>
					</td>
					<td class="px-6 py-4">
						<span class="text-text-tertiary text-sm whitespace-nowrap">{{
							formatDate(item.updatedAt)
						}}</span>
					</td>
				</template>
			</SendTemplateTable>
		</template>

		<template #cards>
			<SendTemplateCardList
				:items="list.items"
				:can-manage="canManage"
				:actions="rowActions"
				@edit="list.handleEdit"
				@duplicate="list.handleDuplicate"
				@delete="list.openDelete"
			>
				<template #meta="{ item }">
					<code class="text-xs font-mono text-text-tertiary">{{ item.slug }}</code>
					<span class="text-text-tertiary text-xs">
						{{ t('dashboard.send.transactional.index.sendCount', { count: sendCount(item) }) }}
					</span>
				</template>
			</SendTemplateCardList>
		</template>

		<TransactionalCreateEmailModal v-model:open="isCreateOpen" />
		<TransactionalApiSnippetModal :email="snippetEmail" @close="snippetEmail = null" />
		<TransactionalRecentSendsModal
			v-model:open="isRecentSendsOpen"
			:email-id="recentSends?.id ?? null"
			:email-name="recentSends?.name ?? ''"
		/>
	</ListPageShell>
</template>
