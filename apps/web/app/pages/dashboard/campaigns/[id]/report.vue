<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import ClickHeatmap from '~/components/dashboard/ClickHeatmap.vue';

useHead({ title: 'Campaign Report — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const route = useRoute();
const router = useRouter();
const campaignId = computed(() => route.params['id'] as Id<'campaigns'>);

// Mutations
const { run: duplicateCampaign } = useBackendOperation(api.campaigns.campaigns.duplicate, {
	label: 'Duplicate campaign',
});
const { run: declareWinner } = useBackendOperation(api.campaigns.abTest.declareABTestWinner, {
	label: 'Declare A/B test winner',
});

// Toast notifications (global)
const { showToast: showNotification } = useToast();

// Handle duplicate
const isDuplicating = ref(false);
const handleDuplicate = async () => {
	if (isDuplicating.value) return;
	isDuplicating.value = true;
	const newCampaignId = await duplicateCampaign({ campaignId: campaignId.value });
	if (newCampaignId === undefined) {
		isDuplicating.value = false;
		return;
	}
	showNotification('Campaign duplicated successfully');
	// Redirect to the new campaign editor
	router.push(`/dashboard/campaigns/${newCampaignId}/edit`);
};

// Fetch campaign with related data
const { data: campaign, isLoading: campaignLoading } = useConvexQuery(
	api.campaigns.campaigns.getWithRelations,
	() => ({ campaignId: campaignId.value })
);

// Fetch email send statistics
const { data: stats, isLoading: statsLoading } = useConvexQuery(
	api.delivery.sends.getStatsByCampaign,
	() => ({ campaignId: campaignId.value })
);

// Fetch opens timeline
const { data: opensTimeline } = useConvexQuery(api.delivery.sends.getOpensTimeline, () => ({
	campaignId: campaignId.value,
}));

// Fetch A/B test stats — only for A/B campaigns. getABTestStats scans both
// variants' emailSends (2×10k); skipping it for the common non-A/B case avoids
// that scan re-running on every emailSends write while the report is open.
const { data: abTestStats } = useConvexQuery(api.campaigns.abTest.getABTestStats, () =>
	campaign.value?.isABTest ? { campaignId: campaignId.value } : 'skip',
);

// Fetch link click stats for heatmap
const { data: linkClickStats } = useConvexQuery(api.delivery.sends.getLinkClickStats, () => ({
	campaignId: campaignId.value,
}));

// A/B test winner selection state
const isSelectingWinner = ref(false);
const handleSelectWinner = async (winner: 'A' | 'B') => {
	if (isSelectingWinner.value) return;
	isSelectingWinner.value = true;
	try {
		const result = await declareWinner({
			campaignId: campaignId.value,
			winner,
		});
		if (result === undefined) return;
		showNotification(`Variant ${winner} declared as winner!`);
	} finally {
		isSelectingWinner.value = false;
	}
};

// Tab state for contacts list
type ContactTab = 'opened' | 'clicked';
const selectedTab = ref<ContactTab>('opened');

// Pagination state
const openedOffset = ref(0);
const clickedOffset = ref(0);
const pageSize = 10;

// Fetch contacts who opened / clicked — only the active tab's list scans
// emailSends; the other is skipped until its tab is selected.
const { data: openedContacts, isLoading: openedLoading } = useConvexQuery(
	api.delivery.sends.getOpenedContacts,
	() =>
		selectedTab.value === 'opened'
			? { campaignId: campaignId.value, limit: pageSize, offset: openedOffset.value }
			: 'skip',
);

const { data: clickedContacts, isLoading: clickedLoading } = useConvexQuery(
	api.delivery.sends.getClickedContacts,
	() =>
		selectedTab.value === 'clicked'
			? { campaignId: campaignId.value, limit: pageSize, offset: clickedOffset.value }
			: 'skip',
);

const isLoading = computed(() => campaignLoading.value || statsLoading.value);

// Archive link
const config = useRuntimeConfig();
const archiveUrl = computed(() => {
	if (!campaign.value?.archiveToken) return null;
	const siteUrl = config.public.siteUrl || window.location.origin;
	return `${siteUrl}/archive?token=${campaign.value.archiveToken}`;
});

const { copy: copyToClipboard, copiedKey: archiveCopiedKey } = useCopyToClipboard();
const ARCHIVE_LINK_COPY_KEY = 'archive-link';
const archiveCopied = computed(() => archiveCopiedKey.value === ARCHIVE_LINK_COPY_KEY);
const copyArchiveLink = async () => {
	if (!archiveUrl.value) return;
	await copyToClipboard(archiveUrl.value, ARCHIVE_LINK_COPY_KEY);
};

// Calculate rates
const openRate = computed(() => {
	if (!stats.value || !stats.value.delivered || stats.value.delivered === 0) return 0;
	return (stats.value.uniqueOpens / stats.value.delivered) * 100;
});

const clickRate = computed(() => {
	if (!stats.value || !stats.value.delivered || stats.value.delivered === 0) return 0;
	return (stats.value.uniqueClicks / stats.value.delivered) * 100;
});

// Stats cards configuration
const statsCards = computed(() => {
	if (!stats.value) return [];
	return [
		{
			// Everything that left the queue (was dispatched to the provider).
			// delivered/opened/clicked now overlap (they're "ever reached"
			// counts), so summing them — the old workaround — would over-count.
			label: 'Sent',
			value: stats.value.total - stats.value.queued - stats.value.failed,
			icon: 'lucide:send',
			color: 'text-brand',
			bgColor: 'bg-brand/10',
		},
		{
			// stats.delivered already counts every recipient who ever reached
			// delivered (incl. those who went on to open/click).
			label: 'Delivered',
			value: stats.value.delivered,
			icon: 'lucide:check-circle-2',
			color: 'text-success',
			bgColor: 'bg-success/10',
		},
		{
			label: 'Opened',
			value: stats.value.uniqueOpens,
			icon: 'lucide:eye',
			color: 'text-brand',
			bgColor: 'bg-brand/10',
			rate: openRate.value,
		},
		{
			label: 'Clicked',
			value: stats.value.uniqueClicks,
			icon: 'lucide:mouse-pointer-click',
			color: 'text-warning',
			bgColor: 'bg-warning/10',
			rate: clickRate.value,
		},
		{
			label: 'Bounced',
			value: stats.value.bounced,
			icon: 'lucide:x-circle',
			color: 'text-error',
			bgColor: 'bg-error/10',
			subStats: [
				{ label: 'Hard', value: stats.value.hardBounced },
				{ label: 'Soft', value: stats.value.softBounced },
			],
		},
	];
});

// Timeline chart data
const chartData = computed(() => {
	if (!opensTimeline.value || opensTimeline.value.length === 0) {
		return { labels: [] as string[], data: [] as number[], maxValue: 0 };
	}

	// Get max value for scaling
	const maxValue = Math.max(
		...opensTimeline.value.map((d: { timestamp: number; count: number }) => d.count),
		1
	);

	// Format labels
	const labels = opensTimeline.value.map((d: { timestamp: number; count: number }) => {
		const date = new Date(d.timestamp);
		return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
	});

	return {
		labels,
		data: opensTimeline.value.map((d: { timestamp: number; count: number }) => d.count),
		maxValue,
	};
});

// Pagination handlers
const loadMoreOpened = () => {
	if (openedContacts.value?.hasMore) {
		openedOffset.value += pageSize;
	}
};

const loadMoreClicked = () => {
	if (clickedContacts.value?.hasMore) {
		clickedOffset.value += pageSize;
	}
};

const loadPrevOpened = () => {
	if (openedOffset.value > 0) {
		openedOffset.value = Math.max(0, openedOffset.value - pageSize);
	}
};

const loadPrevClicked = () => {
	if (clickedOffset.value > 0) {
		clickedOffset.value = Math.max(0, clickedOffset.value - pageSize);
	}
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Loading State -->
		<div v-if="isLoading && !campaign" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<div class="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin" />
				<p class="text-text-secondary text-sm">Loading report...</p>
			</div>
		</div>

		<!-- Campaign Not Found -->
		<div
			v-else-if="!campaign"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:bar-chart-3" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">Campaign not found</p>
			<p class="text-sm text-text-tertiary mt-1">
				This campaign may have been deleted or you don't have access to it.
			</p>
			<NuxtLink to="/dashboard/campaigns" class="btn btn-secondary mt-6">
				Back to Campaigns
			</NuxtLink>
		</div>

		<!-- Report Content -->
		<div v-else>
			<!-- Header -->
			<div class="mb-8">
				<NuxtLink
					to="/dashboard/campaigns"
					class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary text-sm mb-4 transition-colors"
				>
					<Icon name="lucide:arrow-left" class="w-4 h-4" />
					Back to Campaigns
				</NuxtLink>
				<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
					<div>
						<h1 class="text-2xl font-semibold text-text-primary">{{ campaign.name }}</h1>
						<p class="mt-1 text-text-secondary flex items-center gap-2">
							<Icon name="lucide:clock" class="w-4 h-4" />
							Sent {{ formatDateTime(campaign.sentAt) }}
						</p>
					</div>
					<div class="flex items-center gap-3">
						<button
							class="btn btn-secondary gap-2"
							:disabled="isDuplicating"
							@click="handleDuplicate"
						>
							<Icon v-if="isDuplicating" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
							<Icon v-else name="lucide:copy" class="w-4 h-4" />
							{{ isDuplicating ? 'Duplicating...' : 'Duplicate' }}
						</button>
						<span
							class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-success/10 text-success"
						>
							<Icon name="lucide:check-circle-2" class="w-3 h-3" />
							Sent
						</span>
					</div>
				</div>
			</div>

			<!-- Archive Link -->
			<div v-if="archiveUrl" class="card p-4 mb-8">
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:globe" size="sm" rounded="lg" />
						<div class="min-w-0">
							<p class="text-sm font-medium text-text-primary">Public Archive</p>
							<p class="text-xs text-text-tertiary truncate max-w-md">{{ archiveUrl }}</p>
						</div>
					</div>
					<button
						class="btn btn-secondary text-sm gap-1.5"
						@click="copyArchiveLink"
					>
						<Icon :name="archiveCopied ? 'lucide:check' : 'lucide:copy'" class="w-3.5 h-3.5" />
						{{ archiveCopied ? 'Copied' : 'Copy Link' }}
					</button>
				</div>
			</div>

			<!-- Stats Cards -->
			<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
				<div v-for="stat in statsCards" :key="stat.label" class="card p-4">
					<div class="flex items-center gap-3 mb-3">
						<div :class="['w-8 h-8 flex items-center justify-center rounded-lg', stat.bgColor]">
							<Icon :name="stat.icon" :class="['w-4 h-4', stat.color]" />
						</div>
						<span class="text-sm text-text-secondary">{{ stat.label }}</span>
					</div>
					<div class="flex items-baseline gap-2">
						<span class="text-2xl font-semibold text-text-primary">
							{{ stat.value.toLocaleString() }}
						</span>
						<span v-if="stat.rate !== undefined" class="text-sm text-text-tertiary">
							({{ stat.rate.toFixed(1) }}%)
						</span>
					</div>
					<div v-if="stat.subStats" class="flex gap-3 mt-1">
						<span v-for="sub in stat.subStats" :key="sub.label" class="text-xs text-text-tertiary">
							{{ sub.label }}: {{ sub.value }}
						</span>
					</div>
				</div>
			</div>

			<!-- A/B Test Results (if applicable) -->
			<div v-if="campaign.isABTest && abTestStats" class="card p-6 mb-8">
				<div class="flex items-center justify-between mb-6">
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:split" size="sm" rounded="lg" />
						<div>
							<h3 class="text-lg font-medium text-text-primary">A/B Test Results</h3>
							<p class="text-sm text-text-secondary">
								Testing
								{{ abTestStats.config?.testType === 'subject' ? 'Subject Lines' : 'Email Content' }}
							</p>
						</div>
					</div>
					<div
						v-if="abTestStats.winner"
						class="flex items-center gap-2 px-3 py-1.5 bg-success/10 rounded-full"
					>
						<Icon name="lucide:trophy" class="w-4 h-4 text-success" />
						<span class="text-sm font-medium text-success"
							>Variant {{ abTestStats.winner }} won!</span
						>
					</div>
					<div
						v-else-if="abTestStats.status === 'testing'"
						class="flex items-center gap-2 px-3 py-1.5 bg-warning/10 rounded-full"
					>
						<Icon name="lucide:clock" class="w-4 h-4 text-warning" />
						<span class="text-sm font-medium text-warning">Testing in progress</span>
					</div>
				</div>

				<!-- Variant Comparison -->
				<div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
					<!-- Variant A -->
					<div
						:class="[
							'p-4 border rounded-lg transition-colors',
							abTestStats.winner === 'A' ? 'border-brand bg-brand/5' : 'border-border-subtle',
						]"
					>
						<div class="flex items-center justify-between mb-4">
							<div class="flex items-center gap-2">
								<div
									class="w-8 h-8 rounded-full bg-brand/20 text-brand flex items-center justify-center font-bold"
								>
									A
								</div>
								<span class="font-medium text-text-primary">Variant A</span>
								<Icon v-if="abTestStats.winner === 'A'" name="lucide:trophy" class="w-4 h-4 text-success" />
							</div>
						</div>
						<div class="space-y-3">
							<div class="flex justify-between items-center">
								<span class="text-sm text-text-secondary">Sent</span>
								<span class="font-medium text-text-primary">{{
									abTestStats.variantA.sent.toLocaleString()
								}}</span>
							</div>
							<div class="flex justify-between items-center">
								<span class="text-sm text-text-secondary">Open Rate</span>
								<span class="font-medium text-brand"
									>{{ abTestStats.variantA.openRate.toFixed(1) }}%</span
								>
							</div>
							<div class="h-1.5 bg-bg-surface rounded-full overflow-hidden">
								<div
									class="h-full bg-brand rounded-full transition-all"
									:style="{ width: `${Math.min(abTestStats.variantA.openRate, 100)}%` }"
								/>
							</div>
							<div class="flex justify-between items-center">
								<span class="text-sm text-text-secondary">Click Rate</span>
								<span class="font-medium text-warning"
									>{{ abTestStats.variantA.clickRate.toFixed(1) }}%</span
								>
							</div>
							<div class="h-1.5 bg-bg-surface rounded-full overflow-hidden">
								<div
									class="h-full bg-warning rounded-full transition-all"
									:style="{ width: `${Math.min(abTestStats.variantA.clickRate, 100)}%` }"
								/>
							</div>
						</div>
					</div>

					<!-- Variant B -->
					<div
						:class="[
							'p-4 border rounded-lg transition-colors',
							abTestStats.winner === 'B' ? 'border-brand bg-brand/5' : 'border-border-subtle',
						]"
					>
						<div class="flex items-center justify-between mb-4">
							<div class="flex items-center gap-2">
								<div
									class="w-8 h-8 rounded-full bg-brand/20 text-brand flex items-center justify-center font-bold"
								>
									B
								</div>
								<span class="font-medium text-text-primary">Variant B</span>
								<Icon v-if="abTestStats.winner === 'B'" name="lucide:trophy" class="w-4 h-4 text-success" />
							</div>
						</div>
						<div class="space-y-3">
							<div class="flex justify-between items-center">
								<span class="text-sm text-text-secondary">Sent</span>
								<span class="font-medium text-text-primary">{{
									abTestStats.variantB.sent.toLocaleString()
								}}</span>
							</div>
							<div class="flex justify-between items-center">
								<span class="text-sm text-text-secondary">Open Rate</span>
								<span class="font-medium text-brand"
									>{{ abTestStats.variantB.openRate.toFixed(1) }}%</span
								>
							</div>
							<div class="h-1.5 bg-bg-surface rounded-full overflow-hidden">
								<div
									class="h-full bg-brand rounded-full transition-all"
									:style="{ width: `${Math.min(abTestStats.variantB.openRate, 100)}%` }"
								/>
							</div>
							<div class="flex justify-between items-center">
								<span class="text-sm text-text-secondary">Click Rate</span>
								<span class="font-medium text-warning"
									>{{ abTestStats.variantB.clickRate.toFixed(1) }}%</span
								>
							</div>
							<div class="h-1.5 bg-bg-surface rounded-full overflow-hidden">
								<div
									class="h-full bg-warning rounded-full transition-all"
									:style="{ width: `${Math.min(abTestStats.variantB.clickRate, 100)}%` }"
								/>
							</div>
						</div>
					</div>
				</div>

				<!-- Manual Winner Selection (if criteria is manual and no winner yet) -->
				<div
					v-if="
						abTestStats.config?.winnerCriteria === 'manual' &&
						!abTestStats.winner &&
						abTestStats.status === 'testing'
					"
					class="border-t border-border-subtle pt-4"
				>
					<p class="text-sm text-text-secondary mb-3">
						Select the winning variant to send to the remaining audience:
					</p>
					<div class="flex gap-3">
						<button
							class="btn btn-secondary gap-2 flex-1"
							:disabled="isSelectingWinner"
							@click="handleSelectWinner('A')"
						>
							<Icon v-if="isSelectingWinner" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
							<Icon v-else name="lucide:trophy" class="w-4 h-4" />
							Choose Variant A
						</button>
						<button
							class="btn btn-secondary gap-2 flex-1"
							:disabled="isSelectingWinner"
							@click="handleSelectWinner('B')"
						>
							<Icon v-if="isSelectingWinner" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
							<Icon v-else name="lucide:trophy" class="w-4 h-4" />
							Choose Variant B
						</button>
					</div>
				</div>

				<!-- Winner Info -->
				<div
					v-if="abTestStats.winner"
					class="border-t border-border-subtle pt-4 text-sm text-text-secondary"
				>
					Winner selected
					{{ abTestStats.winnerSelectedAt ? formatDateTime(abTestStats.winnerSelectedAt) : '' }} based
					on
					{{
						abTestStats.config?.winnerCriteria === 'open_rate'
							? 'best open rate'
							: abTestStats.config?.winnerCriteria === 'click_rate'
								? 'best click rate'
								: 'manual selection'
					}}
				</div>
			</div>

			<!-- Open Rate & Click Rate Summary -->
			<div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
				<!-- Open Rate Card -->
				<div class="card p-6">
					<div class="flex items-center justify-between mb-4">
						<h3 class="text-lg font-medium text-text-primary">Open Rate</h3>
						<span class="text-3xl font-semibold text-brand">{{ openRate.toFixed(1) }}%</span>
					</div>
					<div class="h-2 bg-bg-surface rounded-full overflow-hidden">
						<div
							class="h-full bg-brand rounded-full transition-all duration-500"
							:style="{ width: `${Math.min(openRate, 100)}%` }"
						/>
					</div>
					<p class="text-sm text-text-tertiary mt-3">
						{{ stats?.uniqueOpens || 0 }} of
						{{ stats?.delivered || 0 }} delivered
						emails were opened
					</p>
				</div>

				<!-- Click Rate Card -->
				<div class="card p-6">
					<div class="flex items-center justify-between mb-4">
						<h3 class="text-lg font-medium text-text-primary">Click Rate</h3>
						<span class="text-3xl font-semibold text-warning">{{ clickRate.toFixed(1) }}%</span>
					</div>
					<div class="h-2 bg-bg-surface rounded-full overflow-hidden">
						<div
							class="h-full bg-warning rounded-full transition-all duration-500"
							:style="{ width: `${Math.min(clickRate, 100)}%` }"
						/>
					</div>
					<p class="text-sm text-text-tertiary mt-3">
						{{ stats?.uniqueClicks || 0 }} of
						{{ stats?.delivered || 0 }} delivered
						emails had link clicks
					</p>
				</div>
			</div>

			<!-- Opens Timeline Chart -->
			<div class="card p-6 mb-8">
				<h3 class="text-lg font-medium text-text-primary mb-6">Opens Over Time</h3>

				<!-- Empty state -->
				<div
					v-if="!opensTimeline || opensTimeline.length === 0"
					class="flex flex-col items-center justify-center py-12 text-center"
				>
					<Icon name="lucide:eye" class="w-12 h-12 text-text-tertiary mb-3" />
					<p class="text-text-secondary">No opens recorded yet</p>
					<p class="text-sm text-text-tertiary mt-1">
						Opens will appear here as recipients view your email
					</p>
				</div>

				<!-- Chart -->
				<div v-else class="relative">
					<!-- Y-axis labels -->
					<div
						class="absolute left-0 top-0 bottom-8 w-8 flex flex-col justify-between text-xs text-text-tertiary"
					>
						<span>{{ chartData.maxValue }}</span>
						<span>{{ Math.floor(chartData.maxValue / 2) }}</span>
						<span>0</span>
					</div>

					<!-- Chart area -->
					<div class="ml-10">
						<div class="flex items-end gap-1 h-48">
							<div
								v-for="(value, index) in chartData.data"
								:key="index"
								class="flex-1 flex flex-col items-center"
							>
								<div
									class="w-full bg-brand/80 hover:bg-brand rounded-t transition-all cursor-pointer"
									:style="{
										height: `${(value / chartData.maxValue) * 100}%`,
										minHeight: value > 0 ? '4px' : '0',
									}"
									:title="`${value} opens`"
								/>
							</div>
						</div>

						<!-- X-axis labels -->
						<div class="flex justify-between mt-2 text-xs text-text-tertiary overflow-hidden">
							<span v-if="chartData.labels.length > 0">{{ chartData.labels[0] }}</span>
							<span v-if="chartData.labels.length > 1">{{
								chartData.labels[Math.floor(chartData.labels.length / 2)]
							}}</span>
							<span v-if="chartData.labels.length > 1">{{
								chartData.labels[chartData.labels.length - 1]
							}}</span>
						</div>
					</div>
				</div>
			</div>

			<!-- Click Heatmap -->
			<div v-if="campaign?.emailTemplate?.htmlContent" class="card p-6 mb-8">
				<div class="flex items-center gap-3 mb-6">
					<UiIconBox icon="lucide:flame" size="sm" variant="warning" rounded="lg" />
					<div>
						<h3 class="text-lg font-medium text-text-primary">Link Click Heatmap</h3>
						<p class="text-sm text-text-secondary">Visual representation of link engagement</p>
					</div>
				</div>

				<ClickHeatmap
					:html-content="campaign.emailTemplate.htmlContent"
					:link-stats="linkClickStats?.links || []"
					:total-delivered="linkClickStats?.totalDelivered || 0"
				/>
			</div>

			<!-- Contacts List -->
			<div class="card p-0 overflow-hidden">
				<!-- Tabs -->
				<div class="flex border-b border-border-subtle">
					<button
						:class="[
							'flex-1 px-6 py-4 text-sm font-medium transition-colors flex items-center justify-center gap-2',
							selectedTab === 'opened'
								? 'text-brand border-b-2 border-brand bg-brand/5'
								: 'text-text-secondary hover:text-text-primary',
						]"
						@click="selectedTab = 'opened'"
					>
						<Icon name="lucide:eye" class="w-4 h-4" />
						Opened ({{ openedContacts?.total || 0 }})
					</button>
					<button
						:class="[
							'flex-1 px-6 py-4 text-sm font-medium transition-colors flex items-center justify-center gap-2',
							selectedTab === 'clicked'
								? 'text-warning border-b-2 border-warning bg-warning/5'
								: 'text-text-secondary hover:text-text-primary',
						]"
						@click="selectedTab = 'clicked'"
					>
						<Icon name="lucide:mouse-pointer-click" class="w-4 h-4" />
						Clicked ({{ clickedContacts?.total || 0 }})
					</button>
				</div>

				<!-- Opened Contacts Tab -->
				<div v-if="selectedTab === 'opened'">
					<!-- Loading -->
					<div v-if="openedLoading && !openedContacts" class="p-8 flex justify-center">
						<Icon name="lucide:loader-2" class="w-6 h-6 text-brand animate-spin" />
					</div>

					<!-- Empty state -->
					<div
						v-else-if="!openedContacts || openedContacts.sends.length === 0"
						class="py-12 text-center"
					>
						<Icon name="lucide:eye" class="w-10 h-10 text-text-tertiary mx-auto mb-3" />
						<p class="text-text-secondary">No contacts have opened this email yet</p>
					</div>

					<!-- List -->
					<div v-else>
						<div class="divide-y divide-border-subtle">
							<div
								v-for="send in openedContacts.sends"
								:key="send._id"
								class="px-6 py-4 flex items-center justify-between hover:bg-bg-surface transition-colors"
							>
								<div class="flex items-center gap-3 min-w-0">
									<UiIconBox icon="lucide:users" size="sm" rounded="full" />
									<div class="min-w-0">
										<div class="text-text-primary font-medium truncate">
											{{
												send.contact?.firstName || send.contact?.email?.split('@')[0] || 'Unknown'
											}}
											{{ send.contact?.lastName || '' }}
										</div>
										<div class="text-sm text-text-tertiary truncate">
											{{ send.contact?.email || 'No email' }}
										</div>
									</div>
								</div>
								<div class="flex items-center gap-4 shrink-0">
									<div class="text-right">
										<div class="text-sm text-text-secondary">
											{{ formatCompactRelativeTime(send.openedAt, { emptyLabel: '—' }) }}
										</div>
										<div v-if="send.openCount > 1" class="text-xs text-text-tertiary">
											{{ send.openCount }} opens
										</div>
									</div>
									<NuxtLink
										:to="`/dashboard/campaigns/${campaignId}/sends/${send._id}`"
										class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
										title="View send details"
									>
										<Icon name="lucide:chevron-right" class="w-4 h-4" />
									</NuxtLink>
								</div>
							</div>
						</div>

						<!-- Pagination -->
						<div
							v-if="openedContacts.total > pageSize"
							class="px-6 py-4 border-t border-border-subtle flex items-center justify-between"
						>
							<button
								class="btn btn-secondary text-sm"
								:disabled="openedOffset === 0"
								@click="loadPrevOpened"
							>
								Previous
							</button>
							<span class="text-sm text-text-tertiary">
								{{ openedOffset + 1 }}-{{
									Math.min(openedOffset + pageSize, openedContacts.total)
								}}
								of {{ openedContacts.total }}
							</span>
							<button
								class="btn btn-secondary text-sm"
								:disabled="!openedContacts.hasMore"
								@click="loadMoreOpened"
							>
								Next
							</button>
						</div>
					</div>
				</div>

				<!-- Clicked Contacts Tab -->
				<div v-if="selectedTab === 'clicked'">
					<!-- Loading -->
					<div v-if="clickedLoading && !clickedContacts" class="p-8 flex justify-center">
						<Icon name="lucide:loader-2" class="w-6 h-6 text-brand animate-spin" />
					</div>

					<!-- Empty state -->
					<div
						v-else-if="!clickedContacts || clickedContacts.sends.length === 0"
						class="py-12 text-center"
					>
						<Icon name="lucide:mouse-pointer-click" class="w-10 h-10 text-text-tertiary mx-auto mb-3" />
						<p class="text-text-secondary">No contacts have clicked links in this email yet</p>
					</div>

					<!-- List -->
					<div v-else>
						<div class="divide-y divide-border-subtle">
							<div
								v-for="send in clickedContacts.sends"
								:key="send._id"
								class="px-6 py-4 hover:bg-bg-surface transition-colors"
							>
								<div class="flex items-center justify-between">
									<div class="flex items-center gap-3 min-w-0">
										<UiIconBox icon="lucide:users" size="sm" variant="warning" rounded="full" />
										<div class="min-w-0">
											<div class="text-text-primary font-medium truncate">
												{{
													send.contact?.firstName || send.contact?.email?.split('@')[0] || 'Unknown'
												}}
												{{ send.contact?.lastName || '' }}
											</div>
											<div class="text-sm text-text-tertiary truncate">
												{{ send.contact?.email || 'No email' }}
											</div>
										</div>
									</div>
									<div class="flex items-center gap-4 shrink-0">
										<div class="text-right">
											<div class="text-sm text-text-secondary">
												{{ formatCompactRelativeTime(send.clickedAt, { emptyLabel: '—' }) }}
											</div>
											<div v-if="send.clickedLinks.length > 0" class="text-xs text-text-tertiary">
												{{ send.clickedLinks.length }} link{{
													send.clickedLinks.length !== 1 ? 's' : ''
												}}
											</div>
										</div>
										<NuxtLink
											:to="`/dashboard/campaigns/${campaignId}/sends/${send._id}`"
											class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
											title="View send details"
										>
											<Icon name="lucide:chevron-right" class="w-4 h-4" />
										</NuxtLink>
									</div>
								</div>
								<!-- Clicked links -->
								<div v-if="send.clickedLinks.length > 0" class="ml-13 mt-2 space-y-1">
									<div
										v-for="(link, linkIndex) in send.clickedLinks.slice(0, 3)"
										:key="linkIndex"
										class="flex items-center gap-2 text-xs text-text-tertiary"
									>
										<Icon name="lucide:external-link" class="w-3 h-3" />
										<span class="truncate max-w-xs">{{ link.url }}</span>
									</div>
									<div v-if="send.clickedLinks.length > 3" class="text-xs text-text-tertiary">
										+{{ send.clickedLinks.length - 3 }} more links
									</div>
								</div>
							</div>
						</div>

						<!-- Pagination -->
						<div
							v-if="clickedContacts.total > pageSize"
							class="px-6 py-4 border-t border-border-subtle flex items-center justify-between"
						>
							<button
								class="btn btn-secondary text-sm"
								:disabled="clickedOffset === 0"
								@click="loadPrevClicked"
							>
								Previous
							</button>
							<span class="text-sm text-text-tertiary">
								{{ clickedOffset + 1 }}-{{
									Math.min(clickedOffset + pageSize, clickedContacts.total)
								}}
								of {{ clickedContacts.total }}
							</span>
							<button
								class="btn btn-secondary text-sm"
								:disabled="!clickedContacts.hasMore"
								@click="loadMoreClicked"
							>
								Next
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
