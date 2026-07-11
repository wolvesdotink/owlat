<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { CampaignStatus } from '~/composables/useCampaignStatusBadge';
import { CAMPAIGN_ATTENTION_DISPLAY, classifyCampaignAttention } from '~/utils/campaignAttention';
import type { CampaignRowFields, DecoratedRow } from '~/utils/campaignCommandRow';

useHead({ title: 'Campaigns — Owlat' });

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

// Search — debounced 300ms, server-side (preserved from the old all-list). The
// shared composable also clears its timer on unmount, so a late tick can't fire
// after the page is gone.
const { searchQuery, debouncedSearch: rawSearch, clear: clearSearch } = useDebouncedSearch(300);
const debouncedSearch = computed(() => rawSearch.value.trim());

// Keyboard: 'n' opens the new-campaign wizard (kept from the old all-list);
// Escape closes the delete-confirm modal (kept from the old all-list).
const { registerNewShortcut, registerEscapeHandler, unregisterShortcut } = useKeyboardShortcuts();
onMounted(() => {
	registerNewShortcut(() => {
		if (!isDeleteModalOpen.value) router.push('/dashboard/campaigns/new');
	});
	registerEscapeHandler(() => {
		if (isDeleteModalOpen.value && !isDeleting.value) closeDeleteModal();
	});
});
onUnmounted(() => {
	unregisterShortcut('n');
	unregisterShortcut('escape');
});

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
} = usePaginatedQuery(
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
} = useOrganizationQuery(api.campaigns.organization.listAttentionCandidates);

const canLoadMore = computed(() => paginationStatus.value === 'CanLoadMore');
const isLoadingMore = computed(() => paginationStatus.value === 'LoadingMore');
function handleLoadMore() {
	if (canLoadMore.value) loadMore(100);
}

const { getStatusBadge } = useCampaignStatusBadge();

// --- Row model: campaign + its attention roll-up + derived rates ------------
// The row TYPE + row COMPONENT live in siblings (utils/campaignCommandRow +
// components/campaigns/CommandRow) so this page stays a controller; here we only
// DERIVE the rows.

function rate(numer: number | undefined, denom: number | undefined): number | null {
	if (!denom || denom <= 0) return null;
	return ((numer ?? 0) / denom) * 100;
}

function decorate(campaign: CampaignRowFields): DecoratedRow {
	const attention = classifyCampaignAttention({
		status: campaign.status,
		scheduledAt: campaign.scheduledAt,
		isABTest: campaign.isABTest,
		abTestStatus: campaign.abTestStatus,
		abWinner: campaign.abWinner,
		contentBlockReason: campaign.contentBlockReason,
	});
	const display = attention.reason ? CAMPAIGN_ATTENTION_DISPLAY[attention.reason] : null;
	const openRate = rate(campaign.statsOpened, campaign.statsDelivered);
	const clickRate = rate(campaign.statsClicked, campaign.statsDelivered);
	// A/B campaigns carry two comparable sends (variant A = main stats,
	// variant B = abVariantB* fields) — a genuine two-point open-rate trend.
	const variantA = openRate;
	const variantB = rate(campaign.abVariantBOpened, campaign.abVariantBSent);
	const spark =
		campaign.isABTest === true && variantA != null && variantB != null ? [variantA, variantB] : [];
	return {
		campaign,
		needsAttention: attention.needsAttention,
		reason: attention.reason,
		reasonChip: display ? { label: display.chipLabel, dot: display.dot } : null,
		statusBadge: getStatusBadge(campaign.status),
		actionLabel: attention.actionLabel,
		openRate,
		clickRate,
		variantA,
		variantB,
		spark,
	};
}

// Sort helper: attention first, then most-recent (updatedAt) — the design
// brief's "surface what needs a decision, then the freshest work".
function byAttentionThenRecency(a: DecoratedRow, b: DecoratedRow): number {
	if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
	return b.campaign.updatedAt - a.campaign.updatedAt;
}

// Attention rows come from the org-wide candidate scan, then the client
// classifier (the source of truth) keeps only the ones genuinely waiting.
// The browse pills search server-side, but the attention set is fetched
// unsearched, so we apply the same debounced query here (case-insensitive
// name/subject over the bounded candidate set) — otherwise typing on the
// default pill would silently no-op and the "No results" empty state would
// lie about a search that never ran.
const attentionRows = computed<DecoratedRow[]>(() => {
	const q = debouncedSearch.value.toLowerCase();
	return (attentionCandidates.value ?? [])
		.map(decorate)
		.filter((r) => r.needsAttention)
		.filter((r) => {
			if (!q) return true;
			const c = r.campaign;
			return c.name.toLowerCase().includes(q) || (c.subject?.toLowerCase().includes(q) ?? false);
		})
		.sort((a, b) => b.campaign.updatedAt - a.campaign.updatedAt);
});

const attentionCount = computed(() => attentionRows.value.length);

// Browse rows come from the paginated (optionally status-filtered) window.
const browseRows = computed<DecoratedRow[]>(() =>
	(rows.value ?? []).map(decorate).sort(byAttentionThenRecency)
);

const visibleRows = computed(() =>
	selectedPill.value === 'attention' ? attentionRows.value : browseRows.value
);

// Surface the right loading / error signal for whichever data source the active
// pill reads from.
const activeError = computed(() =>
	selectedPill.value === 'attention' ? attentionError.value : listError.value
);
const activeLoading = computed(() =>
	selectedPill.value === 'attention' ? attentionLoading.value : isLoading.value
);

interface Pill {
	key: PillKey;
	label: string;
	count: number | undefined;
}
const pills = computed<Pill[]>(() => {
	const c = statusCounts.value;
	return [
		{ key: 'attention', label: 'Needs attention', count: attentionCount.value },
		{ key: 'all', label: 'All', count: c?.['total'] },
		{ key: 'draft', label: 'Drafts', count: c?.['draft'] },
		{ key: 'scheduled', label: 'Scheduled', count: c?.['scheduled'] },
		{ key: 'sent', label: 'Sent', count: c?.['sent'] },
	];
});

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
			// A/B results are folded into the campaign report (piece c3b).
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

// --- Row-level actions: Duplicate + Delete (preserved from the old all-list) -
const { showToast } = useToast();

const { run: duplicateCampaign } = useBackendOperation(api.campaigns.campaigns.duplicate, {
	label: 'Duplicate campaign',
});
const { run: deleteCampaign } = useBackendOperation(api.campaigns.campaigns.remove, {
	label: 'Delete campaign',
});

async function handleDuplicate(id: Id<'campaigns'>) {
	const newId = await duplicateCampaign({ campaignId: id });
	if (newId === undefined) return;
	showToast('Campaign duplicated');
	router.push(`/dashboard/campaigns/${newId}/edit`);
}

const isDeleteModalOpen = ref(false);
const campaignToDelete = ref<{ id: Id<'campaigns'>; name: string } | null>(null);
const isDeleting = ref(false);

function openDeleteModal(id: Id<'campaigns'>, name: string) {
	campaignToDelete.value = { id, name };
	isDeleteModalOpen.value = true;
}
function closeDeleteModal() {
	isDeleteModalOpen.value = false;
	campaignToDelete.value = null;
}
async function handleDelete() {
	if (!campaignToDelete.value) return;
	isDeleting.value = true;
	try {
		const result = await deleteCampaign({ campaignId: campaignToDelete.value.id });
		if (result === undefined) return;
		showToast('Campaign deleted');
		closeDeleteModal();
	} finally {
		isDeleting.value = false;
	}
}

const showEmptyState = computed(
	() => !activeLoading.value && !activeError.value && visibleRows.value.length === 0
);
</script>

<template>
	<div class="p-6 lg:p-8">
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">Campaigns</h1>
				<p class="mt-1 text-text-secondary">
					Everything you've sent and everything waiting on you, in one place.
				</p>
			</div>
			<UiButton @click="handleNewCampaign">
				<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
				New campaign
			</UiButton>
		</div>

		<div class="flex flex-col sm:flex-row sm:items-center gap-4 mb-6">
			<div class="flex items-center gap-1 p-1 bg-bg-surface rounded-lg overflow-x-auto">
				<button
					v-for="pill in pills"
					:key="pill.key"
					:class="[
						'px-3 py-1.5 rounded-md text-sm flex items-center gap-1.5 whitespace-nowrap transition-colors duration-(--motion-fast) ease-spring',
						selectedPill === pill.key
							? 'bg-bg-elevated text-text-primary font-semibold shadow-sm'
							: 'text-text-secondary hover:text-text-primary font-medium',
					]"
					@click="selectedPill = pill.key"
				>
					{{ pill.label }}
					<span v-if="pill.count !== undefined" class="text-xs tabular-nums text-text-tertiary">
						{{ pill.count }}
					</span>
				</button>
			</div>

			<div class="flex-1" />

			<div class="relative">
				<Icon
					name="lucide:search"
					class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary"
				/>
				<input
					v-model="searchQuery"
					type="text"
					placeholder="Search campaigns…"
					class="input pl-10 w-64"
				/>
			</div>
		</div>

		<UiCard v-if="activeLoading && visibleRows.length === 0" padding="none" overflow="hidden">
			<DashboardListSkeleton variant="card" :rows="6" />
		</UiCard>

		<UiErrorAlert
			v-else-if="activeError"
			title="Couldn't load campaigns"
			message="We hit an error loading your campaigns. Reload the page to try again."
			class="my-8"
		/>

		<UiCard
			v-else-if="showEmptyState && selectedPill === 'attention' && !debouncedSearch"
			class="flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox
				icon="lucide:check-circle"
				size="xl"
				variant="success"
				rounded="full"
				class="mb-4"
			/>
			<p class="text-text-primary font-semibold">Nothing needs you.</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				No campaigns are waiting on a decision right now.
			</p>
		</UiCard>

		<UiCard v-else-if="showEmptyState && debouncedSearch" padding="none" overflow="hidden">
			<UiEmptyState
				icon="lucide:search"
				title="No results found"
				:description="`No campaigns match &quot;${debouncedSearch}&quot;. Try a different search term.`"
			>
				<template #action>
					<UiButton variant="secondary" @click="clearSearch">Clear search</UiButton>
				</template>
			</UiEmptyState>
		</UiCard>

		<UiCard v-else-if="showEmptyState" padding="none" overflow="hidden">
			<UiEmptyState
				icon="lucide:send"
				title="No campaigns here yet"
				description="Create your first campaign to start reaching your audience."
			>
				<template #action>
					<UiButton @click="handleNewCampaign">
						<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
						New campaign
					</UiButton>
				</template>
			</UiEmptyState>
		</UiCard>

		<UiCard v-else padding="none" overflow="hidden">
			<ul class="divide-y divide-border-subtle">
				<CampaignsCommandRow
					v-for="row in visibleRows"
					:key="row.campaign._id"
					:row="row"
					@open="openCampaign(row.campaign)"
					@run-action="runAttentionAction(row)"
					@ab-results="openCampaign(row.campaign)"
					@duplicate="handleDuplicate(row.campaign._id)"
					@delete="openDeleteModal(row.campaign._id, row.campaign.name)"
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
					{{ isLoadingMore ? 'Loading…' : 'Load more' }}
				</UiButton>
				<span v-else class="text-sm text-text-tertiary">All campaigns loaded</span>
			</div>
		</UiCard>

		<!-- Delete confirmation -->
		<UiModal v-model:open="isDeleteModalOpen" title="Delete campaign" :persistent="isDeleting">
			<div class="flex items-start gap-4">
				<div class="p-3 rounded-full bg-error/10 shrink-0 flex items-center justify-center">
					<Icon name="lucide:trash-2" class="w-6 h-6 text-error" />
				</div>
				<div>
					<p class="text-text-primary">
						Are you sure you want to delete
						<span class="font-semibold">"{{ campaignToDelete?.name }}"</span>?
					</p>
					<p class="text-sm text-text-secondary mt-2">
						This action cannot be undone. The campaign and its data will be permanently deleted.
					</p>
				</div>
			</div>
			<template #footer>
				<UiButton variant="secondary" :disabled="isDeleting" @click="closeDeleteModal">
					Cancel
				</UiButton>
				<UiButton variant="danger" :loading="isDeleting" @click="handleDelete">
					{{ isDeleting ? 'Deleting…' : 'Delete campaign' }}
				</UiButton>
			</template>
		</UiModal>
	</div>
</template>
