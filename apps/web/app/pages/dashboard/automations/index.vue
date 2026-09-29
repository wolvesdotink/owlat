<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { AutomationListItem } from '~/components/automations/ListTable.vue';
import { useListPage } from '~/composables/useListPage';

const { t } = useI18n();

useHead({ title: () => t('dashboard.automations.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();

const { hasActiveOrganization, isLoading: teamLoading } = useOrganizationContext();
// Every automation write — create, edit, duplicate, activate/pause, delete —
// requires `automations:manage` (owner/admin) on the backend
// (`apps/api/convex/automations/guards.ts`). The list stays readable for every
// member; only the write actions come off for an editor.
const { can, showGateFor } = usePermissions();
const canManage = computed(() => can('automations:manage'));
const showManageGate = computed(() => showGateFor('automations:manage'));

const { showToast } = useToast();

const { run: duplicateAutomation } = useBackendOperation(api.automations.automations.duplicate, {
	label: () => t('dashboard.automations.index.operations.duplicate'),
});
const { run: deleteAutomation } = useBackendOperation(api.automations.automations.remove, {
	label: () => t('dashboard.automations.index.operations.delete'),
});
const { run: pauseAutomation } = useBackendOperation(api.automations.automations.pause, {
	label: () => t('dashboard.automations.index.operations.pause'),
});
const { run: resumeAutomation } = useBackendOperation(api.automations.automations.resume, {
	label: () => t('dashboard.automations.index.operations.resume'),
});

const handleNewAutomation = () => router.push('/dashboard/automations/new');

// Both of the shell's row slots render the same component in its two layouts.
const rowLayouts = ['table', 'cards'] as const;

// The list filter (debounced, client-side over the loaded rows), the delete
// dialog and the `n` / Escape shortcuts. No sort menu: the status tabs narrow
// this list. `reactive` unwraps the refs, so the template reads `list.*`.
const list = reactive(
	useListPage<AutomationListItem>({
		onDelete: async (automation) => {
			const result = await deleteAutomation({ automationId: automation._id });
			if (result.ok) showToast(t('dashboard.automations.index.toasts.deleted'));
			return result.ok;
		},
		onNew: handleNewAutomation,
		canCreate: canManage,
	})
);

// Status filter — runs server-side through the Listing engine (ADR-0037).
type StatusFilter = 'all' | AutomationListItem['status'];
const selectedStatus = ref<StatusFilter>('all');

const { data: statusCounts } = useOrganizationQuery(api.automations.automations.countByStatus);

const statusFilters = computed(() => {
	const counts = statusCounts.value;
	return [
		{ value: 'all', label: t('common.all'), count: counts?.['total'] },
		{ value: 'active', label: t('common.active'), count: counts?.['active'] },
		{
			value: 'paused',
			label: t('dashboard.automations.index.status.paused'),
			count: counts?.['paused'],
		},
		{
			value: 'draft',
			label: t('dashboard.automations.index.status.draft'),
			count: counts?.['draft'],
		},
	];
});

const {
	results: automations,
	isLoading: automationsLoading,
	error: automationsError,
	refetch: refetchAutomations,
} = useOrganizationPaginatedQuery(
	api.automations.automations.list,
	() => ({
		status: selectedStatus.value === 'all' ? undefined : selectedStatus.value,
	}),
	{ initialNumItems: 100, keepPreviousData: true }
);

const filteredAutomations = computed<AutomationListItem[]>(() => {
	const search = list.debouncedSearch.trim().toLowerCase();
	if (!search) return automations.value;
	return automations.value.filter(
		(automation) =>
			automation.name.toLowerCase().includes(search) ||
			automation.description?.toLowerCase().includes(search)
	);
});

// keepPreviousData: a refetch (a new status tab) keeps the old rows on screen,
// so only a load with nothing to show yet takes the skeleton.
const showSkeleton = computed(
	() => (teamLoading.value || automationsLoading.value) && automations.value.length === 0
);

// Delete is offered only for an automation that is not running, but the row is
// live: one activated while the dialog is open is refused, not deleted.
const deleteBlocked = computed(() => {
	const target = list.deleteTarget;
	if (!target) return false;
	const live = automations.value.find((automation) => automation._id === target._id);
	return (live ?? target).status === 'active';
});

// --- Row actions ------------------------------------------------------------

const togglingId = ref<Id<'automations'> | null>(null);

const handleToggleStatus = async (automation: AutomationListItem) => {
	// Re-entrancy guard: ignore repeat clicks while a toggle is already running
	// (the inline button and the menu item both call this).
	if (togglingId.value) return;
	if (automation.status === 'draft') {
		showToast(t('dashboard.automations.index.toasts.draftNotToggleable'), 'error');
		return;
	}

	togglingId.value = automation._id;
	try {
		if (automation.status === 'active') {
			if (!(await pauseAutomation({ automationId: automation._id })).ok) return;
			showToast(t('dashboard.automations.index.toasts.paused', { name: automation.name }));
		} else {
			if (!(await resumeAutomation({ automationId: automation._id })).ok) return;
			showToast(t('dashboard.automations.index.toasts.activated', { name: automation.name }));
		}
	} finally {
		togglingId.value = null;
	}
};

const handleDuplicate = async (automation: AutomationListItem) => {
	const result = await duplicateAutomation({ automationId: automation._id });
	if (result.ok) showToast(t('dashboard.automations.index.toasts.duplicated'));
};

const handleEdit = (automation: AutomationListItem) =>
	router.push(`/dashboard/automations/${automation._id}/edit`);

const handleViewDetails = (automation: AutomationListItem) =>
	router.push(`/dashboard/automations/${automation._id}`);
</script>

<template>
	<ListPageShell
		v-model:search="list.searchQuery"
		:title="t('dashboard.automations.index.title')"
		:description="t('dashboard.automations.index.subtitle')"
		:loading="showSkeleton"
		:error="automationsError"
		:error-title="t('dashboard.automations.index.errorTitle')"
		:has-organization="hasActiveOrganization"
		:is-empty="filteredAutomations.length === 0"
		:active-search="list.debouncedSearch.trim()"
		:search-placeholder="t('common.filterPlaceholder')"
		:empty-no-org="{
			icon: 'lucide:zap',
			title: t('dashboard.automations.index.noTeam.title'),
			description: t('dashboard.automations.index.noTeam.description'),
		}"
		:empty="{
			icon: 'lucide:zap',
			title: t('dashboard.automations.index.empty.title'),
			description: t('dashboard.automations.index.empty.description'),
		}"
		:no-results="{
			title: t('dashboard.automations.index.noResults.title'),
			description: t('dashboard.automations.index.noResults.description', {
				query: list.debouncedSearch.trim(),
			}),
		}"
		:delete-copy="{
			title: t('dashboard.automations.index.deleteDialog.title'),
			confirmKeypath: 'dashboard.automations.index.deleteDialog.body',
			description: t('dashboard.automations.index.deleteDialog.note'),
			confirmText: t('dashboard.automations.index.deleteDialog.title'),
		}"
		:delete-open="list.isDeleteOpen"
		:delete-name="list.deleteTarget?.name"
		:is-deleting="list.isDeleting"
		:delete-blocked="deleteBlocked"
		@retry="refetchAutomations"
		@clear-search="list.clearSearch"
		@confirm-delete="list.confirmDelete"
		@cancel-delete="list.closeDelete"
	>
		<template #actions>
			<UiButton v-if="canManage" size="sm" @click="handleNewAutomation">
				<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
				{{ t('dashboard.automations.index.newAutomation') }}
			</UiButton>
			<p v-else-if="showManageGate" class="text-xs text-text-tertiary">
				{{ t('dashboard.automations.index.adminsOnly') }}
			</p>
		</template>

		<template #filters>
			<div class="max-w-full overflow-x-auto">
				<UiSegmentedControl
					:model-value="selectedStatus"
					:options="statusFilters"
					:aria-label="t('dashboard.automations.index.statusFilterLabel')"
					class="min-w-max"
					@update:model-value="selectedStatus = $event as StatusFilter"
				>
					<template v-for="filter in statusFilters" :key="filter.value" #[`option-${filter.value}`]>
						{{ filter.label }}
						<span v-if="filter.count !== undefined" class="tabular-nums text-text-tertiary">
							{{ filter.count }}
						</span>
					</template>
				</UiSegmentedControl>
			</div>
		</template>

		<template v-if="canManage" #empty-action>
			<UiButton @click="handleNewAutomation">
				<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
				{{ t('dashboard.automations.index.empty.action') }}
			</UiButton>
		</template>

		<template #loading>
			<UiCard padding="none" overflow="hidden">
				<DashboardListSkeleton variant="table" :columns="6" :rows="6" />
			</UiCard>
		</template>

		<template v-for="layout in rowLayouts" :key="layout" #[layout]>
			<AutomationsListTable :items="filteredAutomations" :layout="layout" :can-manage="canManage">
				<template #actions="{ automation, touch }">
					<AutomationsRowActions
						:automation="automation"
						:can-manage="canManage"
						:toggling="togglingId === automation._id"
						:touch="touch"
						@toggle="handleToggleStatus"
						@edit="handleEdit"
						@view="handleViewDetails"
						@duplicate="handleDuplicate"
						@delete="list.openDelete"
					/>
				</template>
			</AutomationsListTable>
		</template>

		<template #delete-extra>
			<p
				v-if="deleteBlocked"
				class="text-sm text-warning mt-2 flex items-center justify-center gap-1.5"
			>
				<Icon name="lucide:alert-circle" class="w-4 h-4" />
				{{ t('dashboard.automations.index.deleteDialog.activeWarning') }}
			</p>
		</template>
	</ListPageShell>
</template>
