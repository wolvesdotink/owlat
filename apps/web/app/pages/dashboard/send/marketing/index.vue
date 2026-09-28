<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import { sortTemplateRows } from '~/utils/templateListSort';

type TemplateRow = FunctionReturnType<typeof api.emailTemplates.emails.list>['page'][number];

const { t } = useI18n();

useHead({ title: () => t('dashboard.send.marketing.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Creating, duplicating and deleting a template all require `templates:manage`
// (owner/admin) on the backend — `apps/api/convex/emailTemplates/emails.ts`.
// Browsing and opening one stays open to every member; the writes do not.
const { can, showGateFor } = usePermissions();
const canManage = computed(() => can('templates:manage'));
const showManageGate = computed(() => showGateFor('templates:manage'));
const { isPending: authPending, isAuthenticated } = useAuth();
const router = useRouter();
const { showToast } = useToast();

const { run: duplicateTemplate } = useBackendOperation(api.emailTemplates.emails.duplicate, {
	label: () => t('dashboard.send.marketing.index.operations.duplicate'),
});
const { run: deleteTemplate } = useBackendOperation(api.emailTemplates.emails.remove, {
	label: () => t('dashboard.send.marketing.index.operations.delete'),
});
const { run: createTemplate } = useBackendOperation(api.emailTemplates.emails.create, {
	label: () => t('dashboard.send.marketing.index.operations.create'),
});
const { run: createFromPreset } = useBackendOperation(
	api.emailTemplates.organization.createFromPreset,
	{ label: () => t('dashboard.send.marketing.index.operations.create') }
);

// Template library modal
const isTemplateLibraryOpen = ref(false);
const templateLibraryRef = ref<{
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
	templateName: string;
	isCreating: boolean;
} | null>(null);

// `reactive` unwraps the composable's refs, so the template reads `list.items`.
const list = reactive(
	useTemplateList<TemplateRow>({
		// Type filter + full-text search run server-side through the Listing engine
		// (ADR-0037); the sort is applied client-side over the loaded page, and a
		// search keeps the engine's relevance order.
		query: ({ search, sort }) => {
			const { results, isLoading, error, refetch } = usePaginatedQuery(
				api.emailTemplates.emails.list,
				() => {
					if (authPending.value || !isAuthenticated.value) return 'skip';
					return { type: 'marketing' as const, search: search.value || undefined };
				},
				{ initialNumItems: 100 }
			);
			const rows = computed(() =>
				search.value ? results.value : sortTemplateRows(results.value, sort.value)
			);
			return { rows, isLoading, error, refetch };
		},
		defaultViewMode: 'grid',
		editPath: (template) => `/dashboard/send/emails/${template._id}/edit`,
		onDuplicate: async (template) => {
			const result = await duplicateTemplate({ templateId: template._id });
			if (result.ok) showToast(t('dashboard.send.marketing.index.toasts.duplicated'));
		},
		onDelete: async (template) => {
			const result = await deleteTemplate({ templateId: template._id });
			if (result.ok) showToast(t('dashboard.send.marketing.index.toasts.deleted'));
			return result.ok;
		},
		onNew: () => (isTemplateLibraryOpen.value = true),
		canCreate: () => canManage.value,
		isBusy: () => isTemplateLibraryOpen.value,
		onEscape: () => {
			if (!isTemplateLibraryOpen.value || templateLibraryRef.value?.isCreating) return false;
			isTemplateLibraryOpen.value = false;
			return true;
		},
	})
);

const { data: typeCounts } = useOrganizationQuery(
	api.emailTemplates.organization.countByTypeByOrganization
);

const handleTemplateCreate = (templateId: Id<'emailTemplates'>) => {
	router.push(`/dashboard/send/emails/${templateId}/edit`);
};

const handleCreateSubmit = async () => {
	await templateLibraryRef.value?.handleCreate(createTemplate, createFromPreset);
};
</script>

<template>
	<ListPageShell
		v-model:search="list.searchQuery"
		v-model:view-mode="list.viewMode"
		:title="t('dashboard.send.marketing.index.title')"
		:description="t('dashboard.send.marketing.index.subtitle')"
		:loading="list.isLoading"
		:error="list.error"
		:error-title="t('dashboard.send.marketing.index.loadError')"
		:loading-label="t('dashboard.send.marketing.index.loadingTemplates')"
		:has-organization="list.hasOrganization"
		:is-empty="list.isEmpty"
		:active-search="list.debouncedSearch"
		:search-placeholder="t('dashboard.send.marketing.index.searchPlaceholder')"
		:sort-options="list.sortOptions"
		:sort="list.currentSort.value"
		:sort-label="t('dashboard.send.marketing.index.sortLabel')"
		sort-listbox-id="marketing-sort-listbox"
		:empty-no-org="{
			icon: 'lucide:mail',
			title: t('dashboard.send.marketing.index.emptyNoTeam.title'),
			description: t('dashboard.send.marketing.index.emptyNoTeam.description'),
		}"
		:empty="{
			icon: 'lucide:megaphone',
			title: t('dashboard.send.marketing.index.empty.title'),
			description: t('dashboard.send.marketing.index.empty.description'),
		}"
		:no-results="{
			title: t('dashboard.send.marketing.index.noResults.title'),
			description: t('dashboard.send.marketing.index.noResults.description', {
				query: list.debouncedSearch,
			}),
		}"
		:delete-copy="{
			title: t('dashboard.send.marketing.index.delete.title'),
			confirmKeypath: 'dashboard.send.marketing.index.delete.confirm',
			description: t('dashboard.send.marketing.index.delete.description'),
			confirmText: t('dashboard.send.marketing.index.delete.confirmButton'),
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
			<UiButton v-if="canManage" size="sm" @click="isTemplateLibraryOpen = true">
				<template #iconLeft>
					<Icon name="lucide:plus" class="w-4 h-4" />
				</template>
				{{ t('dashboard.send.marketing.index.newTemplate') }}
			</UiButton>
			<p v-else-if="showManageGate" class="text-xs text-text-tertiary">
				{{ t('dashboard.send.marketing.index.adminsOnly') }}
			</p>
		</template>

		<template #filters>
			<p v-if="typeCounts" class="text-sm text-text-secondary">
				{{
					t(
						'dashboard.send.marketing.index.templateCount',
						{ count: typeCounts['marketing'] },
						typeCounts['marketing'] ?? 0
					)
				}}
			</p>
		</template>

		<template v-if="canManage" #empty-action>
			<UiButton @click="isTemplateLibraryOpen = true">
				<template #iconLeft>
					<Icon name="lucide:plus" class="w-4 h-4" />
				</template>
				{{ t('dashboard.send.marketing.index.empty.action') }}
			</UiButton>
		</template>

		<template #grid>
			<SendTemplateGrid
				:items="list.items"
				:can-manage="canManage"
				@edit="list.handleEdit"
				@duplicate="list.handleDuplicate"
				@delete="list.openDelete"
			/>
		</template>

		<template #table>
			<SendTemplateTable
				:items="list.items"
				:columns="[
					t('common.name'),
					t('dashboard.send.marketing.index.columns.subject'),
					t('common.status'),
					t('dashboard.send.marketing.index.columns.updated'),
				]"
				:can-manage="canManage"
				@edit="list.handleEdit"
				@duplicate="list.handleDuplicate"
				@delete="list.openDelete"
			>
				<template #cells="{ item }">
					<td class="px-6 py-4">
						<span class="text-text-primary font-medium">{{ item.name }}</span>
					</td>
					<td class="px-6 py-4">
						<span class="text-text-secondary">{{ item.subject || '-' }}</span>
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
			/>
		</template>

		<LazyMailTemplateLibraryModal
			ref="templateLibraryRef"
			v-model:open="isTemplateLibraryOpen"
			@create="handleTemplateCreate"
		>
			<template #submit-button="{ isCreating }">
				<UiButton type="submit" :loading="isCreating" @click="handleCreateSubmit">
					{{
						isCreating
							? t('dashboard.send.marketing.index.creating')
							: t('dashboard.send.marketing.index.createAndEdit')
					}}
				</UiButton>
			</template>
		</LazyMailTemplateLibraryModal>
	</ListPageShell>
</template>
