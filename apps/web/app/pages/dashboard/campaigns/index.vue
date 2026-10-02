<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { useCampaignCommandRows } from '~/composables/useCampaignCommandRows';
import { useListPage } from '~/composables/useListPage';
import type { CampaignStatus } from '~/composables/useCampaignStatusBadge';
import type { CampaignRowFields, DecoratedRow } from '~/utils/campaignCommandRow';

const { t } = useI18n();

useHead({ title: () => t('dashboard.campaigns.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();
const route = useRoute();

// One command center replaces the old overview / all-list / reports trio.
// It opens on "Needs attention" — the campaigns genuinely waiting on a human —
// and falls back to plain browsing for everything else.
type PillKey = 'attention' | 'all' | 'draft' | 'scheduled' | 'sent';

// ?status= deep-links from the retired routes map onto the pills, so existing
// links (e.g. /dashboard/campaigns/all?status=scheduled) still land correctly.
function pillFromQuery(raw: unknown): PillKey {
	switch (raw) {
		case 'draft':
			return 'draft';
		case 'scheduled':
			return 'scheduled';
		case 'sent':
			return 'sent';
		case 'all':
			return 'all';
		default:
			return 'attention';
	}
}

const selectedPill = ref<PillKey>(pillFromQuery(route.query['status']));

// Keep the URL shareable: reflect the active pill into ?status= without adding
// history entries, and mirror it back if the query changes underneath us.
watch(selectedPill, (pill) => {
	const status = pill === 'attention' ? undefined : pill;
	router.replace({ query: { ...route.query, status } });
});
watch(
	() => route.query['status'],
	(raw) => {
		const next = pillFromQuery(raw);
		if (next !== selectedPill.value) selectedPill.value = next;
	}
);

const { hasActiveOrganization, isLoading: teamLoading } = useOrganizationContext();

const { showToast } = useToast();

const { run: duplicateCampaign } = useBackendOperation(api.campaigns.campaigns.duplicate, {
	label: () => t('dashboard.campaigns.index.duplicateOperation'),
});
const { run: deleteCampaign } = useBackendOperation(api.campaigns.campaigns.remove, {
	label: () => t('dashboard.campaigns.index.deleteOperation'),
});

// Search (debounced, server-side), the delete dialog and the `n` / Escape
// shortcuts. No sort menu: the status tabs are how this list narrows down.
// `reactive` unwraps the refs, so the template reads `list.searchQuery`.
const list = reactive(
	useListPage<CampaignRowFields>({
		onDelete: async (campaign) => {
			const result = await deleteCampaign({ campaignId: campaign._id });
			if (result.ok) showToast(t('dashboard.campaigns.index.toasts.deleted'));
			return result.ok;
		},
		onNew: () => handleNewCampaign(),
	})
);
const debouncedSearch = computed(() => list.debouncedSearch.trim());

// The active pill drives a SERVER-SIDE status filter for the browse pills so the
// list can never disagree with the org-wide count badge (e.g. "Sent 250" while
// only a windowful shows). Attention / All browse the full table unfiltered.
const serverStatus = computed<CampaignStatus | undefined>(() => {
	switch (selectedPill.value) {
		case 'draft':
		case 'scheduled':
		case 'sent':
			return selectedPill.value;
		default:
			return undefined;
	}
});

// ONE paginated query returns rows WITH their denormalized headline stats (no
// per-row fan-out / N+1). Search + status filter are server-side; the pill
// numeric badges come from the exact org-wide count facet.
const {
	results: rows,
	status: paginationStatus,
	loadMore,
	isLoading,
	error: listError,
	refetch: refetchList,
} = useOrganizationPaginatedQuery(
	api.campaigns.campaigns.list,
	() => ({ status: serverStatus.value, search: debouncedSearch.value || undefined }),
	{ initialNumItems: 100, keepPreviousData: true }
);

const { data: statusCounts } = useOrganizationQuery(
	api.campaigns.organization.countByStatusByOrganization
);

// Attention is classified over ALL candidate campaigns (a bounded org-wide scan
// of the transient statuses), NOT the loaded window — so "Nothing needs you."
// can never be a false negative for an undecided A/B test or a stopped send that
// happens to sit past the first page.
const {
	data: attentionCandidates,
	isLoading: attentionLoading,
	error: attentionError,
	refetch: refetchAttention,
} = useOrganizationQuery(api.campaigns.organization.listAttentionCandidates);

const canLoadMore = computed(() => paginationStatus.value === 'CanLoadMore');
const isLoadingMore = computed(() => paginationStatus.value === 'LoadingMore');
function handleLoadMore() {
	if (canLoadMore.value) loadMore(100);
}

// --- Row model: campaign + its attention roll-up + derived rates ------------
// The DERIVATION, the row TYPE and the row COMPONENT all live in siblings
// (composables/useCampaignCommandRows + utils/campaignCommandRow +
// components/campaigns/CommandRow) so this page stays a controller.
const { attentionRows, attentionCount, browseRows } = useCampaignCommandRows({
	rows: () => rows.value,
	attentionCandidates: () => attentionCandidates.value,
	search: () => debouncedSearch.value,
});

const visibleRows = computed(() =>
	selectedPill.value === 'attention' ? attentionRows.value : browseRows.value
);

// ⌘K on this page offers what this page does — new campaign, and the report or
// editor of any campaign currently listed. Registered for the page's lifetime;
// the composable owns the palette wiring.
useCampaignCommandSurface({
	rows: () =>
		visibleRows.value.map((row) => ({
			id: row.campaign._id,
			name: row.campaign.name,
			opensReport: row.campaign.status === 'sent' || row.campaign.status === 'sending',
		})),
});

// Surface the right loading / error signal for whichever data source the active
// pill reads from.
const activeError = computed(() =>
	selectedPill.value === 'attention' ? attentionError.value : listError.value
);
const activeLoading = computed(() =>
	selectedPill.value === 'attention' ? attentionLoading.value : isLoading.value
);
// keepPreviousData: a refetch (new pill, new search) keeps the old rows on
// screen, so only a load with nothing to show yet takes the skeleton.
const showSkeleton = computed(
	() => (teamLoading.value || activeLoading.value) && visibleRows.value.length === 0
);
function retryActive() {
	if (selectedPill.value === 'attention') refetchAttention();
	else refetchList();
}

interface Pill {
	value: PillKey;
	label: string;
	count: number | undefined;
}
const pills = computed<Pill[]>(() => {
	const c = statusCounts.value;
	return [
		{
			value: 'attention',
			label: t('dashboard.campaigns.index.pills.attention'),
			count: attentionCount.value,
		},
		{ value: 'all', label: t('common.all'), count: c?.['total'] },
		{ value: 'draft', label: t('dashboard.campaigns.index.pills.drafts'), count: c?.['draft'] },
		{
			value: 'scheduled',
			label: t('dashboard.campaigns.index.pills.scheduled'),
			count: c?.['scheduled'],
		},
		{ value: 'sent', label: t('dashboard.campaigns.index.pills.sent'), count: c?.['sent'] },
	];
});

// An empty "Needs attention" is good news, not a missing list: it gets its own
// all-clear copy and no create action. The browse tabs share "nothing here yet".
const emptyCopy = computed(() =>
	selectedPill.value === 'attention'
		? {
				icon: 'lucide:check-circle',
				eyebrow: t('dashboard.campaigns.index.attentionEmpty.eyebrow'),
				title: t('dashboard.campaigns.index.attentionEmpty.title'),
				description: t('dashboard.campaigns.index.attentionEmpty.description'),
			}
		: {
				icon: 'lucide:send',
				title: t('dashboard.campaigns.index.listEmpty.title'),
				description: t('dashboard.campaigns.index.listEmpty.description'),
			}
);

// --- Presentational helpers -------------------------------------------------

/** Row click opens the report for sent/sending campaigns, else the editor. */
function openCampaign(campaign: CampaignRowFields) {
	if (campaign.status === 'sent' || campaign.status === 'sending') {
		router.push(`/dashboard/campaigns/${campaign._id}/report`);
	} else {
		router.push(`/dashboard/campaigns/${campaign._id}/edit`);
	}
}

/** The inline attention action navigates only — no fake backend calls. */
function runAttentionAction(row: DecoratedRow) {
	const id = row.campaign._id;
	switch (row.reason) {
		case 'ab_decision':
			// A/B results are folded into the campaign report.
			router.push(`/dashboard/campaigns/${id}/report`);
			break;
		case 'needs_review':
		// The review surface is the editor's pending-review panel — NOT the
		// report (which shows zeros for an unsent campaign). A stopped send is
		// resumed from the same editor, so both land there.
		case 'send_stopped':
			router.push(`/dashboard/campaigns/${id}/edit`);
			break;
		default:
			openCampaign(row.campaign);
	}
}
function handleNewCampaign() {
	router.push('/dashboard/campaigns/new');
}

// --- Row-level actions: Duplicate (Delete goes through `list.openDelete`) ----
async function handleDuplicate(id: Id<'campaigns'>) {
	const newId = await duplicateCampaign({ campaignId: id });
	if (!newId.ok) return;
	showToast(t('dashboard.campaigns.index.toasts.duplicated'));
	router.push(`/dashboard/campaigns/${newId.result}/edit`);
}
</script>

<template>
	<ListPageShell
		v-model:search="list.searchQuery"
		:title="t('dashboard.campaigns.index.title')"
		:description="t('dashboard.campaigns.index.subtitle')"
		:loading="showSkeleton"
		:error="activeError"
		:error-title="t('dashboard.campaigns.index.errorTitle')"
		:has-organization="hasActiveOrganization"
		:is-empty="visibleRows.length === 0"
		:active-search="debouncedSearch"
		:search-placeholder="t('dashboard.campaigns.index.searchPlaceholder')"
		:empty-no-org="{
			icon: 'lucide:send',
			title: t('dashboard.campaigns.index.noWorkspace.title'),
			description: t('dashboard.campaigns.index.noWorkspace.description'),
		}"
		:empty="emptyCopy"
		:no-results="{
			title: t('dashboard.campaigns.index.searchEmpty.title'),
			description: t('dashboard.campaigns.index.searchEmpty.description', {
				query: debouncedSearch,
			}),
		}"
		:delete-copy="{
			title: t('dashboard.campaigns.index.deleteDialog.title'),
			confirmKeypath: 'dashboard.campaigns.index.deleteDialog.confirmQuestion',
			description: t('dashboard.campaigns.index.deleteDialog.description'),
			confirmText: t('dashboard.campaigns.index.deleteDialog.confirm'),
		}"
		:delete-open="list.isDeleteOpen"
		:delete-name="list.deleteTarget?.name"
		:is-deleting="list.isDeleting"
		@retry="retryActive"
		@clear-search="list.clearSearch"
		@confirm-delete="list.confirmDelete"
		@cancel-delete="list.closeDelete"
	>
		<!-- On desktop the top bar's primary is already New campaign in the
		     Marketing workspace; the header copy is for phones, whose top bar
		     has no create button. -->
		<template #actions>
			<UiButton class="lg:hidden" @click="handleNewCampaign">
				<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
				{{ t('dashboard.campaigns.index.newCampaign') }}
			</UiButton>
		</template>

		<!-- Five tabs with counts do not fit a phone: the strip scrolls sideways
		     at its natural width rather than spilling out of its track. -->
		<template #filters>
			<div class="max-w-full overflow-x-auto">
				<UiSegmentedControl
					:model-value="selectedPill"
					:options="pills"
					:aria-label="t('dashboard.campaigns.index.statusFilterLabel')"
					fit="content"
					class="min-w-max"
					@update:model-value="selectedPill = $event as PillKey"
				>
					<template v-for="pill in pills" :key="pill.value" #[`option-${pill.value}`]>
						{{ pill.label }}
						<span v-if="pill.count !== undefined" class="tabular-nums text-text-tertiary">
							{{ pill.count }}
						</span>
					</template>
				</UiSegmentedControl>
			</div>
		</template>

		<template v-if="selectedPill !== 'attention'" #empty-action>
			<UiButton @click="handleNewCampaign">
				<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
				{{ t('dashboard.campaigns.index.newCampaign') }}
			</UiButton>
		</template>

		<template #loading>
			<UiCard padding="none" overflow="hidden">
				<DashboardListSkeleton variant="card" :rows="6" />
			</UiCard>
		</template>

		<!-- One row layout at every width, so there is no #table. -->
		<template #cards>
			<ul class="divide-y divide-border-subtle">
				<CampaignsCommandRow
					v-for="row in visibleRows"
					:key="row.campaign._id"
					:row="row"
					@open="openCampaign(row.campaign)"
					@run-action="runAttentionAction(row)"
					@ab-results="openCampaign(row.campaign)"
					@duplicate="handleDuplicate(row.campaign._id)"
					@delete="list.openDelete(row.campaign)"
				/>
			</ul>

			<div
				v-if="selectedPill !== 'attention' && (canLoadMore || paginationStatus === 'Exhausted')"
				class="flex items-center justify-center px-6 py-4 border-t border-border-subtle"
			>
				<UiButton
					v-if="canLoadMore"
					variant="secondary"
					:loading="isLoadingMore"
					@click="handleLoadMore"
				>
					{{ isLoadingMore ? t('common.loading') : t('dashboard.campaigns.index.loadMore') }}
				</UiButton>
				<span v-else class="text-sm text-text-tertiary">
					{{ t('dashboard.campaigns.index.allLoaded') }}
				</span>
			</div>
		</template>
	</ListPageShell>
</template>
