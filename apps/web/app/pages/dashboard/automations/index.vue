<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { AutomationListItem } from '~/components/automations/ListTable.vue';
import type { AutomationHealth } from '~/components/automations/HealthSummary.vue';
import { useListPage } from '~/composables/useListPage';
import { useMarketingDeleteUndo } from '~/composables/useMarketingDeleteUndo';
import { usePostboxTriageUndo } from '~/composables/postbox/usePostboxTriageUndo';
import type { ContextMenuItem } from '@owlat/ui/components/ui/ContextMenu.vue';
import { useRowLinkMenu } from '~/composables/useRowLinkMenu';
import {
	automationRowHref,
	automationRowVerbs,
	type AutomationRowVerbId,
} from '~/utils/automationRowVerbs';

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
const { run: restoreAutomation } = useBackendOperation(api.automations.automations.restore, {
	label: () => t('dashboard.automations.index.operations.restore'),
});
const { deleteWithUndo } = useMarketingDeleteUndo();
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
// and the `n` / Escape shortcuts. No sort menu: the status tabs narrow this
// list. A delete runs at once (the automation goes to Recently deleted) and the
// toast offers Undo; the row menu offers it only for one that is not running,
// and the server refuses one that was activated meanwhile.
// `reactive` unwraps the refs, so the template reads `list.*`.
const list = reactive(
	useListPage<AutomationListItem>({
		confirmDelete: false,
		onDelete: (automation) =>
			deleteWithUndo({
				name: automation.name,
				remove: async () => (await deleteAutomation({ automationId: automation._id })).ok,
				restore: () => restoreAutomation({ automationId: automation._id }),
			}),
		onNew: handleNewAutomation,
		canCreate: canManage,
	})
);

// Status filter — runs server-side through the Listing engine.
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

// The last-7-days column, read for the rows on screen. The server answers for
// at most 100 automations, the size of the first page.
const HEALTH_IDS_LIMIT = 100;
const healthIds = computed(() =>
	automations.value.slice(0, HEALTH_IDS_LIMIT).map((automation) => automation._id)
);
const { data: healthRows } = useOrganizationQuery(api.automations.health.summaries, () =>
	healthIds.value.length > 0 ? { automationIds: healthIds.value } : undefined
);
const healthById = computed(
	() =>
		new Map<string, AutomationHealth>(
			(healthRows.value ?? []).map((row) => [row.automationId, row])
		)
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

// --- Row actions ------------------------------------------------------------

const togglingId = ref<Id<'automations'> | null>(null);

// A pause or resume goes on the app's one undo stack, like a delete. The undo
// sends back the stamp the change wrote, and the server refuses it once the
// status has changed again (another admin, the failure breaker), so an undo
// never reverses a later change. It restores the status only: runs a pause
// cancelled stay cancelled.
const undoStack = usePostboxTriageUndo();

const handleToggleStatus = async (automation: AutomationListItem) => {
	// Re-entrancy guard: ignore repeat clicks while a toggle is already running
	// (the inline switch and the menu item both call this).
	if (togglingId.value) return;
	if (automation.status === 'draft') {
		showToast(t('dashboard.automations.index.toasts.draftNotToggleable'), 'error');
		return;
	}

	const automationId = automation._id;
	const pausing = automation.status === 'active';
	togglingId.value = automationId;
	try {
		const outcome = pausing
			? await pauseAutomation({ automationId })
			: await resumeAutomation({ automationId });
		if (!outcome.ok) return;
		const label = pausing
			? t('dashboard.automations.index.toasts.paused', { name: automation.name })
			: t('dashboard.automations.index.toasts.activated', { name: automation.name });
		// Null when it was already in that state: nothing changed, nothing to undo.
		const statusChangedAt = outcome.result?.statusChangedAt ?? null;
		if (statusChangedAt === null) {
			showToast(label);
			return;
		}
		undoStack.register({
			label,
			inverse: async () => {
				const args = { automationId, ifStatusChangedAt: statusChangedAt };
				await (pausing ? resumeAutomation(args) : pauseAutomation(args));
			},
		});
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

// The row's context menu: the overflow menu's verbs, run by the same handlers,
// then the link verbs for where the row's name leads (none when it is plain text).
const { linkItems } = useRowLinkMenu();
const verbHandlers: Record<AutomationRowVerbId, (automation: AutomationListItem) => unknown> = {
	view: handleViewDetails,
	edit: handleEdit,
	duplicate: handleDuplicate,
	toggle: handleToggleStatus,
	delete: (automation) => list.openDelete(automation),
};
const rowMenu = (automation: AutomationListItem): ContextMenuItem[] => {
	const verbs: ContextMenuItem[] = automationRowVerbs(automation.status, canManage.value).map(
		(verb) => ({
			id: verb.id,
			label: t(verb.labelKey),
			icon: verb.icon,
			danger: verb.danger,
			separatorBefore: verb.separatorBefore,
			disabled: verb.id === 'toggle' && togglingId.value === automation._id,
			run: () => void verbHandlers[verb.id](automation),
		})
	);
	const href = automationRowHref(automation, canManage.value);
	return href ? [...verbs, ...linkItems(href)] : verbs;
};
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
		@retry="refetchAutomations"
		@clear-search="list.clearSearch"
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
			<AutomationsListTable
				:items="filteredAutomations"
				:layout="layout"
				:can-manage="canManage"
				:health="healthById"
				:menu-items="rowMenu"
			>
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
	</ListPageShell>
</template>
