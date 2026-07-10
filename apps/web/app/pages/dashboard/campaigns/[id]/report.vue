<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import ClickHeatmap from '~/components/dashboard/ClickHeatmap.vue';
import CampaignAbComparison from '~/components/dashboard/CampaignAbComparison.vue';
import { selectPreviousComparable, computeStatDeltas, NO_DELTAS } from '~/utils/campaignReport';

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

// Recent sent-campaign snapshots — used to diff this send against the prior
// comparable send (same kind) for the hero-tile deltas. Cheap (index take, no
// emailSends read); the pure selection + delta math runs client-side.
const { data: comparableSends } = useConvexQuery(
	api.campaigns.analytics.getComparableSentCampaigns,
	() => ({})
);

// Fetch A/B test stats — only for A/B campaigns. getABTestStats scans both
// variants' emailSends (2×10k); skipping it for the common non-A/B case avoids
// that scan re-running on every emailSends write while the report is open.
const { data: abTestStats } = useConvexQuery(api.campaigns.abTest.getABTestStats, () =>
	campaign.value?.isABTest ? { campaignId: campaignId.value } : 'skip'
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
		const result = await declareWinner({ campaignId: campaignId.value, winner });
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
			: 'skip'
);

const { data: clickedContacts, isLoading: clickedLoading } = useConvexQuery(
	api.delivery.sends.getClickedContacts,
	() =>
		selectedTab.value === 'clicked'
			? { campaignId: campaignId.value, limit: pageSize, offset: clickedOffset.value }
			: 'skip'
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

// Everything dispatched to the provider (the delivery-rate denominator).
const sentCount = computed(() => {
	if (!stats.value) return 0;
	return stats.value.total - stats.value.queued - stats.value.failed;
});

// Rates
const openRate = computed(() => {
	if (!stats.value || !stats.value.delivered) return 0;
	return (stats.value.uniqueOpens / stats.value.delivered) * 100;
});

const clickRate = computed(() => {
	if (!stats.value || !stats.value.delivered) return 0;
	return (stats.value.uniqueClicks / stats.value.delivered) * 100;
});

// Delta vs previous comparable send ---------------------------------------
const previousComparable = computed(() => {
	const list = comparableSends.value;
	const sentAt = campaign.value?.sentAt;
	if (!list || sentAt === undefined) return null;
	return selectPreviousComparable(list, {
		id: campaignId.value,
		sentAt,
		isABTest: campaign.value?.isABTest ?? false,
	});
});

const deltas = computed(() => {
	if (!stats.value) {
		return NO_DELTAS;
	}
	return computeStatDeltas(
		{
			sent: sentCount.value,
			delivered: stats.value.delivered,
			opened: stats.value.uniqueOpens,
			clicked: stats.value.uniqueClicks,
			bounced: stats.value.bounced,
		},
		previousComparable.value
	);
});

// Hero stat tiles — Delivered / Opened / Clicked / Bounced.
const heroTiles = computed(() => {
	if (!stats.value) return [];
	const s = stats.value;
	return [
		{ key: 'delivered', label: 'Delivered', value: s.delivered, delta: deltas.value.delivered },
		{ key: 'opened', label: 'Opened', value: s.uniqueOpens, delta: deltas.value.opened },
		{ key: 'clicked', label: 'Clicked', value: s.uniqueClicks, delta: deltas.value.clicked },
		{ key: 'bounced', label: 'Bounced', value: s.bounced, delta: deltas.value.bounced },
	];
});

// Opens timeline → first-48h curve for UiTrendChart. Labels are hours since
// the first recorded open; the peak is direct-labeled by the chart.
const timelineData = computed<{ label: string; value: number }[]>(() => {
	const raw = opensTimeline.value;
	if (!raw || raw.length === 0) return [];
	const start = raw[0]!.timestamp;
	const cutoff = start + 48 * 60 * 60 * 1000;
	return raw
		.filter((d) => d.timestamp <= cutoff)
		.map((d) => ({
			label: `${Math.round((d.timestamp - start) / (60 * 60 * 1000))}h`,
			value: d.count,
		}));
});

// Pagination handlers
const loadMoreOpened = () => {
	if (openedContacts.value?.hasMore) openedOffset.value += pageSize;
};
const loadMoreClicked = () => {
	if (clickedContacts.value?.hasMore) clickedOffset.value += pageSize;
};
const loadPrevOpened = () => {
	if (openedOffset.value > 0) openedOffset.value = Math.max(0, openedOffset.value - pageSize);
};
const loadPrevClicked = () => {
	if (clickedOffset.value > 0) clickedOffset.value = Math.max(0, clickedOffset.value - pageSize);
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Loading State -->
		<div v-if="isLoading && !campaign" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading report...</p>
			</div>
		</div>

		<!-- Campaign Not Found -->
		<div
			v-else-if="!campaign"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox
				icon="lucide:bar-chart-3"
				size="xl"
				variant="surface"
				rounded="full"
				class="mb-4"
			/>
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
					class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary text-sm mb-4 transition-colors duration-(--motion-fast)"
				>
					<Icon name="lucide:arrow-left" class="w-4 h-4" />
					Back to Campaigns
				</NuxtLink>
				<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
					<div>
						<h1 class="text-2xl font-semibold text-text-primary">{{ campaign.name }}</h1>
						<p class="mt-1 text-text-secondary text-sm flex flex-wrap items-center gap-x-2 gap-y-1">
							<span class="inline-flex items-center gap-1.5">
								<Icon name="lucide:clock" class="w-4 h-4" />
								Sent {{ formatDateTime(campaign.sentAt) }}
							</span>
							<span class="text-text-tertiary">·</span>
							<span class="tabular-nums">{{ sentCount.toLocaleString() }} recipients</span>
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
					<button class="btn btn-secondary text-sm gap-1.5" @click="copyArchiveLink">
						<Icon :name="archiveCopied ? 'lucide:check' : 'lucide:copy'" class="w-3.5 h-3.5" />
						{{ archiveCopied ? 'Copied' : 'Copy Link' }}
					</button>
				</div>
			</div>

			<!-- Hero stat tiles -->
			<div class="card p-6 mb-8">
				<div class="grid grid-cols-2 lg:grid-cols-4 gap-6">
					<UiStatTile
						v-for="tile in heroTiles"
						:key="tile.key"
						:label="tile.label"
						:value="tile.value.toLocaleString()"
						:delta="tile.delta.text"
						:delta-direction="tile.delta.direction"
					/>
				</div>
				<p class="mt-4 text-xs text-text-tertiary">
					<template v-if="previousComparable">
						Change vs your previous {{ campaign.isABTest ? 'A/B ' : '' }}send ·
						{{ previousComparable.name }}
					</template>
					<template v-else> No comparable prior send to compare against yet. </template>
				</p>
			</div>

			<!-- A/B Test fold-in -->
			<div v-if="campaign.isABTest && abTestStats" class="mb-8">
				<CampaignAbComparison
					:stats="abTestStats"
					:is-selecting-winner="isSelectingWinner"
					@select-winner="handleSelectWinner"
				/>
			</div>

			<!-- Open & Click rate (progress bars read better than a bare number vs a 100% target) -->
			<div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
				<div class="card p-6">
					<div class="flex items-baseline justify-between mb-4">
						<h3 class="text-base font-medium text-text-primary">Open rate</h3>
						<span class="font-display text-3xl text-text-primary tabular-nums leading-none"
							>{{ openRate.toFixed(1) }}%</span
						>
					</div>
					<div class="h-2 bg-bg-surface rounded-full overflow-hidden">
						<div
							class="h-full bg-brand rounded-full transition-all duration-(--motion-slow) ease-(--ease-spring)"
							:style="{ width: `${Math.min(openRate, 100)}%` }"
						/>
					</div>
					<p class="text-sm text-text-tertiary mt-3 tabular-nums">
						{{ (stats?.uniqueOpens ?? 0).toLocaleString() }} of
						{{ (stats?.delivered ?? 0).toLocaleString() }} delivered opened
					</p>
				</div>

				<div class="card p-6">
					<div class="flex items-baseline justify-between mb-4">
						<h3 class="text-base font-medium text-text-primary">Click rate</h3>
						<span class="font-display text-3xl text-text-primary tabular-nums leading-none"
							>{{ clickRate.toFixed(1) }}%</span
						>
					</div>
					<div class="h-2 bg-bg-surface rounded-full overflow-hidden">
						<div
							class="h-full bg-brand rounded-full transition-all duration-(--motion-slow) ease-(--ease-spring)"
							:style="{ width: `${Math.min(clickRate, 100)}%` }"
						/>
					</div>
					<p class="text-sm text-text-tertiary mt-3 tabular-nums">
						{{ (stats?.uniqueClicks ?? 0).toLocaleString() }} of
						{{ (stats?.delivered ?? 0).toLocaleString() }} delivered clicked a link
					</p>
				</div>
			</div>

			<!-- Opens Timeline -->
			<div class="card p-6 mb-8">
				<div class="flex items-baseline justify-between mb-6">
					<h3 class="text-base font-medium text-text-primary">Opens over time</h3>
					<span class="text-xs text-text-tertiary">First 48 hours</span>
				</div>

				<!-- Empty state -->
				<div
					v-if="timelineData.length === 0"
					class="flex flex-col items-center justify-center py-12 text-center"
				>
					<Icon name="lucide:eye" class="w-10 h-10 text-text-tertiary mb-3" />
					<p class="text-text-secondary">No opens recorded yet</p>
					<p class="text-sm text-text-tertiary mt-1">
						Opens will appear here as recipients view your email.
					</p>
				</div>

				<UiTrendChart
					v-else
					:data="timelineData"
					label-peak
					:format-value="(v: number) => v.toLocaleString()"
					aria-label="Opens over the first 48 hours"
				/>
			</div>

			<!-- Click Heatmap -->
			<div v-if="campaign?.emailTemplate?.htmlContent" class="card p-6 mb-8">
				<div class="flex items-center gap-3 mb-6">
					<UiIconBox icon="lucide:flame" size="sm" variant="warning" rounded="lg" />
					<div>
						<h3 class="text-base font-medium text-text-primary">Link click heatmap</h3>
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
							'flex-1 px-6 py-4 text-sm transition-colors duration-(--motion-fast) flex items-center justify-center gap-2',
							selectedTab === 'opened'
								? 'text-text-primary font-semibold border-b-2 border-brand'
								: 'text-text-secondary font-medium hover:text-text-primary',
						]"
						@click="selectedTab = 'opened'"
					>
						<Icon name="lucide:eye" class="w-4 h-4" />
						Opened ({{ openedContacts?.total || 0 }})
					</button>
					<button
						:class="[
							'flex-1 px-6 py-4 text-sm transition-colors duration-(--motion-fast) flex items-center justify-center gap-2',
							selectedTab === 'clicked'
								? 'text-text-primary font-semibold border-b-2 border-brand'
								: 'text-text-secondary font-medium hover:text-text-primary',
						]"
						@click="selectedTab = 'clicked'"
					>
						<Icon name="lucide:mouse-pointer-click" class="w-4 h-4" />
						Clicked ({{ clickedContacts?.total || 0 }})
					</button>
				</div>

				<!-- Opened Contacts Tab -->
				<div v-if="selectedTab === 'opened'">
					<div v-if="openedLoading && !openedContacts" class="p-8 flex justify-center">
						<Icon name="lucide:loader-2" class="w-6 h-6 text-brand animate-spin" />
					</div>

					<div
						v-else-if="!openedContacts || openedContacts.sends.length === 0"
						class="py-12 text-center"
					>
						<Icon name="lucide:eye" class="w-10 h-10 text-text-tertiary mx-auto mb-3" />
						<p class="text-text-secondary">No contacts have opened this email yet</p>
					</div>

					<div v-else>
						<div class="divide-y divide-border-subtle">
							<div
								v-for="send in openedContacts.sends"
								:key="send._id"
								class="px-6 py-4 flex items-center justify-between hover:bg-bg-surface transition-colors duration-(--motion-fast)"
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
										<div v-if="send.openCount > 1" class="text-xs text-text-tertiary tabular-nums">
											{{ send.openCount }} opens
										</div>
									</div>
									<NuxtLink
										:to="`/dashboard/campaigns/${campaignId}/sends/${send._id}`"
										class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
										title="View send details"
									>
										<Icon name="lucide:chevron-right" class="w-4 h-4" />
									</NuxtLink>
								</div>
							</div>
						</div>

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
							<span class="text-sm text-text-tertiary tabular-nums">
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
					<div v-if="clickedLoading && !clickedContacts" class="p-8 flex justify-center">
						<Icon name="lucide:loader-2" class="w-6 h-6 text-brand animate-spin" />
					</div>

					<div
						v-else-if="!clickedContacts || clickedContacts.sends.length === 0"
						class="py-12 text-center"
					>
						<Icon
							name="lucide:mouse-pointer-click"
							class="w-10 h-10 text-text-tertiary mx-auto mb-3"
						/>
						<p class="text-text-secondary">No contacts have clicked links in this email yet</p>
					</div>

					<div v-else>
						<div class="divide-y divide-border-subtle">
							<div
								v-for="send in clickedContacts.sends"
								:key="send._id"
								class="px-6 py-4 hover:bg-bg-surface transition-colors duration-(--motion-fast)"
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
											<div
												v-if="send.clickedLinks.length > 0"
												class="text-xs text-text-tertiary tabular-nums"
											>
												{{ send.clickedLinks.length }} link{{
													send.clickedLinks.length !== 1 ? 's' : ''
												}}
											</div>
										</div>
										<NuxtLink
											:to="`/dashboard/campaigns/${campaignId}/sends/${send._id}`"
											class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
											title="View send details"
										>
											<Icon name="lucide:chevron-right" class="w-4 h-4" />
										</NuxtLink>
									</div>
								</div>
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
							<span class="text-sm text-text-tertiary tabular-nums">
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
