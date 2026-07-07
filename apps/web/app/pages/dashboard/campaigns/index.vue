<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { CampaignStatus } from '~/composables/useCampaignStatusBadge';
import { classifyCampaignAttention, type CampaignAttentionReason } from '~/utils/campaignAttention';

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

// Search — debounced 300ms, server-side (preserved from the old all-list).
const searchQuery = ref('');
const debouncedSearch = ref('');
let searchTimeout: ReturnType<typeof setTimeout> | null = null;
watch(searchQuery, (value) => {
	if (searchTimeout) clearTimeout(searchTimeout);
	searchTimeout = setTimeout(() => {
		debouncedSearch.value = value.trim();
	}, 300);
});
function clearSearch() {
	searchQuery.value = '';
	debouncedSearch.value = '';
}

// Keyboard: 'n' opens the new-campaign wizard (kept from the old all-list).
const { registerNewShortcut, unregisterShortcut } = useKeyboardShortcuts();
onMounted(() => {
	registerNewShortcut(() => router.push('/dashboard/campaigns/new'));
});
onUnmounted(() => {
	unregisterShortcut('n');
});

// ONE paginated query returns rows WITH their denormalized headline stats (no
// per-row fan-out / N+1). Status filter + attention classification run
// client-side over the loaded window; search stays server-side; pill numeric
// badges come from the exact org-wide count facet.
const {
	results: rows,
	status: paginationStatus,
	loadMore,
	isLoading,
} = usePaginatedQuery(
	api.campaigns.campaigns.list,
	() => ({ search: debouncedSearch.value || undefined }),
	{ initialNumItems: 100 }
);

const { data: statusCounts } = useOrganizationQuery(
	api.campaigns.organization.countByStatusByOrganization
);

const canLoadMore = computed(() => paginationStatus.value === 'CanLoadMore');
const isLoadingMore = computed(() => paginationStatus.value === 'LoadingMore');
function handleLoadMore() {
	if (canLoadMore.value) loadMore(100);
}

const { getStatusBadge } = useCampaignStatusBadge();

// --- Row model: campaign + its attention roll-up + derived rates ------------
type CampaignRow = NonNullable<typeof rows.value>[number];

interface ReasonChip {
	label: string;
	dot: string;
}

interface DecoratedRow {
	campaign: CampaignRow;
	needsAttention: boolean;
	reason: CampaignAttentionReason | null;
	/** Precomputed chip for the reason (or null) — keeps the template out of a
	 * possibly-null index access. */
	reasonChip: ReasonChip | null;
	actionLabel: string | null;
	openRate: number | null;
	clickRate: number | null;
	/** Variant open-rate mini-trend for A/B sends; empty ⇒ sparkline hidden. */
	spark: number[];
}

const REASON_CHIP: Record<CampaignAttentionReason, ReasonChip> = {
	ab_decision: { label: 'Pick a winner', dot: 'bg-brand' },
	needs_review: { label: 'Needs review', dot: 'bg-warning' },
	send_stopped: { label: 'Send stopped', dot: 'bg-error' },
	scheduled_today: { label: 'Going out today', dot: 'bg-brand' },
};

function rate(numer: number | undefined, denom: number | undefined): number | null {
	if (!denom || denom <= 0) return null;
	return ((numer ?? 0) / denom) * 100;
}

const decorated = computed<DecoratedRow[]>(() =>
	(rows.value ?? []).map((campaign): DecoratedRow => {
		const attention = classifyCampaignAttention({
			status: campaign.status,
			scheduledAt: campaign.scheduledAt,
			isABTest: campaign.isABTest,
			abTestStatus: campaign.abTestStatus,
			abWinner: campaign.abWinner,
			contentBlockReason: campaign.contentBlockReason,
		});
		const openRate = rate(campaign.statsOpened, campaign.statsDelivered);
		const clickRate = rate(campaign.statsClicked, campaign.statsDelivered);
		// A/B campaigns carry two comparable sends (variant A = main stats,
		// variant B = abVariantB* fields) — a genuine two-point open-rate trend.
		const variantA = rate(campaign.statsOpened, campaign.statsDelivered);
		const variantB = rate(campaign.abVariantBOpened, campaign.abVariantBSent);
		const spark =
			campaign.isABTest === true && variantA != null && variantB != null
				? [variantA, variantB]
				: [];
		return {
			campaign,
			needsAttention: attention.needsAttention,
			reason: attention.reason,
			reasonChip: attention.reason ? REASON_CHIP[attention.reason] : null,
			actionLabel: attention.actionLabel,
			openRate,
			clickRate,
			spark,
		};
	})
);

const attentionCount = computed(() => decorated.value.filter((r) => r.needsAttention).length);

// Client-side pill filter over the loaded rows.
function matchesPill(row: DecoratedRow, pill: PillKey): boolean {
	switch (pill) {
		case 'attention':
			return row.needsAttention;
		case 'all':
			return true;
		default:
			return row.campaign.status === pill;
	}
}

// Sort: attention first, then most-recent (updatedAt) — the design brief's
// "surface what needs a decision, then the freshest work".
const visibleRows = computed(() => {
	const filtered = decorated.value.filter((r) => matchesPill(r, selectedPill.value));
	return [...filtered].sort((a, b) => {
		if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
		return b.campaign.updatedAt - a.campaign.updatedAt;
	});
});

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

/** Meta line under the campaign name — one human sentence per state. */
function metaLine(row: DecoratedRow): string {
	const c = row.campaign;
	if (row.reason === 'ab_decision') {
		const a = rate(c.statsOpened, c.statsDelivered);
		const b = rate(c.abVariantBOpened, c.abVariantBSent);
		if (a != null && b != null) {
			const diff = Math.abs(a - b);
			const leader = b >= a ? 'B' : 'A';
			if (diff >= 0.1) return `Variant ${leader} leads by ${diff.toFixed(1)} pts`;
			return 'Variants are running even';
		}
		return 'A/B test in progress';
	}
	if (c.status === 'scheduled') {
		return c.scheduledAt ? `Scheduled for ${formatDateTime(c.scheduledAt)}` : 'Scheduled';
	}
	if (c.status === 'sending') return 'Sending now';
	if (c.status === 'cancelled') return 'Send was stopped';
	if (c.status === 'sent') {
		const recipients = c.statsDelivered ?? c.statsSent ?? 0;
		return `Sent ${formatDate(c.sentAt)} · ${recipients.toLocaleString()} recipients`;
	}
	return `Draft · updated ${formatCompactRelativeTime(c.updatedAt)}`;
}

/** Row click opens the report for sent/sending campaigns, else the editor. */
function openCampaign(campaign: CampaignRow) {
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
			router.push('/dashboard/campaigns/ab-results');
			break;
		case 'needs_review':
			openReport(id);
			break;
		case 'send_stopped':
			router.push(`/dashboard/campaigns/${id}/edit`);
			break;
		default:
			openCampaign(row.campaign);
	}
}
function openReport(id: Id<'campaigns'>) {
	router.push(`/dashboard/campaigns/${id}/report`);
}
function handleNewCampaign() {
	router.push('/dashboard/campaigns/new');
}

const showEmptyState = computed(() => !isLoading.value && visibleRows.value.length === 0);
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

		<div v-if="isLoading && !rows" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading campaigns…</p>
			</div>
		</div>

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

		<UiCard
			v-else-if="showEmptyState && debouncedSearch"
			class="flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:search" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-primary font-semibold">No results found</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				No campaigns match "{{ debouncedSearch }}". Try a different search term.
			</p>
			<UiButton variant="secondary" class="mt-6" @click="clearSearch">Clear search</UiButton>
		</UiCard>

		<UiCard
			v-else-if="showEmptyState"
			class="flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:send" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-primary font-semibold">No campaigns here yet</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				Create your first campaign to start reaching your audience.
			</p>
			<UiButton class="mt-6" @click="handleNewCampaign">
				<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
				New campaign
			</UiButton>
		</UiCard>

		<UiCard v-else padding="none" overflow="hidden">
			<ul class="divide-y divide-border-subtle">
				<li
					v-for="row in visibleRows"
					:key="row.campaign._id"
					class="group flex items-center gap-4 px-4 sm:px-6 py-4 hover:bg-bg-surface transition-colors duration-(--motion-moderate) ease-spring cursor-pointer"
					@click="openCampaign(row.campaign)"
				>
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2 min-w-0">
							<span
								:class="[
									'truncate text-text-primary',
									row.needsAttention ? 'font-semibold' : 'font-medium',
								]"
							>
								{{ row.campaign.name }}
							</span>
							<span
								v-if="row.campaign.isABTest"
								class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium text-text-secondary bg-bg-elevated shrink-0"
								title="A/B test"
							>
								<Icon name="lucide:split" class="w-3 h-3" />
								A/B
							</span>
						</div>

						<div class="flex items-center gap-2 mt-1 min-w-0">
							<!-- One roll-up chip: attention reason when present, else status -->
							<span
								v-if="row.reasonChip"
								class="inline-flex items-center gap-1.5 text-xs text-text-secondary shrink-0"
							>
								<span :class="['w-1.5 h-1.5 rounded-full', row.reasonChip.dot]" />
								{{ row.reasonChip.label }}
							</span>
							<span
								v-else
								:class="[
									'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium shrink-0',
									getStatusBadge(row.campaign.status as CampaignStatus).color,
								]"
							>
								<Icon
									:name="getStatusBadge(row.campaign.status as CampaignStatus).icon"
									:class="['w-3 h-3', row.campaign.status === 'sending' ? 'animate-spin' : '']"
								/>
								{{ getStatusBadge(row.campaign.status as CampaignStatus).label }}
							</span>
							<span class="text-xs text-text-tertiary truncate">{{ metaLine(row) }}</span>
						</div>
					</div>

					<!-- Sparkline (A/B variant open-rate trend; hidden otherwise) -->
					<UiSparkline
						v-if="row.spark.length >= 2"
						:data="row.spark"
						:aria-label="`Variant open-rate trend for ${row.campaign.name}`"
						class="hidden md:inline-block shrink-0"
					/>

					<div class="hidden sm:flex items-center gap-6 shrink-0">
						<div class="text-right w-16">
							<p class="text-sm font-semibold tabular-nums text-text-primary">
								{{ row.openRate != null ? `${row.openRate.toFixed(1)}%` : '—' }}
							</p>
							<p class="text-[11px] text-text-tertiary">Open</p>
						</div>
						<div class="text-right w-16">
							<p class="text-sm font-semibold tabular-nums text-text-primary">
								{{ row.clickRate != null ? `${row.clickRate.toFixed(1)}%` : '—' }}
							</p>
							<p class="text-[11px] text-text-tertiary">Click</p>
						</div>
					</div>

					<!-- Inline primary action for attention rows -->
					<div class="shrink-0 w-24 flex justify-end" @click.stop>
						<UiButton
							v-if="row.actionLabel"
							size="sm"
							variant="secondary"
							@click="runAttentionAction(row)"
						>
							{{ row.actionLabel }}
						</UiButton>
						<button
							v-else
							class="ui-hover-reveal p-2 rounded-lg text-text-tertiary hover:text-brand transition-colors duration-(--motion-fast) ease-spring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
							title="View campaign"
							aria-label="View campaign"
							@click="openCampaign(row.campaign)"
						>
							<Icon name="lucide:arrow-right" class="w-4 h-4" />
						</button>
					</div>
				</li>
			</ul>

			<div
				v-if="canLoadMore || paginationStatus === 'Exhausted'"
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
	</div>
</template>
