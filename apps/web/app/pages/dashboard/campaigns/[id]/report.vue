<script setup lang="ts">
import { api } from '@owlat/api';
import ClickHeatmap from '~/components/dashboard/ClickHeatmap.vue';
import CampaignSendPlanLine from '~/components/campaigns/CampaignSendPlanLine.vue';
import CampaignAbComparison from '~/components/dashboard/CampaignAbComparison.vue';
import CampaignAutomatedOpensNote from '~/components/campaigns/CampaignAutomatedOpensNote.vue';
import CampaignFunnel from '~/components/campaigns/CampaignFunnel.vue';
import CampaignReportHeadline from '~/components/campaigns/CampaignReportHeadline.vue';
import CampaignReportComparison from '~/components/campaigns/CampaignReportComparison.vue';
import { selectPreviousComparable } from '~/utils/campaignReport';
import { formatNumber } from '~/utils/formatters';

const { t } = useI18n();

useHead({ title: () => t('dashboard.campaigns.detail.report.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();
const campaignId = useRouteId<'campaigns'>();

// Mutations
const { run: duplicateCampaign } = useBackendOperation(api.campaigns.campaigns.duplicate, {
	label: () => t('dashboard.campaigns.detail.report.duplicateOperation'),
});
const { run: declareWinner } = useBackendOperation(api.campaigns.abTest.declareABTestWinner, {
	label: () => t('dashboard.campaigns.detail.report.declareWinnerOperation'),
});

const { showToast: showNotification } = useToast();

// Handle duplicate
const isDuplicating = ref(false);
const handleDuplicate = async () => {
	if (isDuplicating.value) return;
	isDuplicating.value = true;
	const newCampaignId = await duplicateCampaign({ campaignId: campaignId.value });
	if (!newCampaignId.ok) {
		isDuplicating.value = false;
		return;
	}
	showNotification(t('dashboard.campaigns.detail.report.toasts.duplicated'));
	router.push(`/dashboard/campaigns/${newCampaignId.result}/edit`);
};

// Fetch campaign with related data
const {
	data: campaign,
	isLoading: campaignLoading,
	error: campaignError,
	refetch: refetchCampaign,
} = useConvexQuery(api.campaigns.campaigns.getWithRelations, () => ({
	campaignId: campaignId.value,
}));

// Fetch email send statistics
const { data: stats, isLoading: statsLoading } = useConvexQuery(
	api.delivery.sends.getStatsByCampaign,
	() => ({ campaignId: campaignId.value })
);

// The multi-day send plan's day-of-N state. `null` for a campaign with no walk
// in flight, which renders nothing at all — absence of a plan is not a state
// anyone has to explain.
const { data: sendPlan } = useConvexQuery(
	api.campaigns.sendPlanQueries.getCampaignSendPlan,
	() => ({
		campaignId: campaignId.value,
	})
);

// Fetch opens timeline
const { data: opensTimeline } = useConvexQuery(api.delivery.sends.getOpensTimeline, () => ({
	campaignId: campaignId.value,
}));

// Recent sent-campaign snapshots — used to diff this send against the prior
// comparable send (same kind) for the comparison row. Cheap (index take, no
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
		if (!result.ok) return;
		showNotification(
			t('dashboard.campaigns.detail.report.toasts.winnerDeclared', { variant: winner })
		);
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

/**
 * THE REPORT BEFORE THERE IS ANYTHING TO REPORT.
 *
 * Pressing send now lands here immediately (the send is held one undo window
 * out, so the campaign is `scheduled` for its first minute and `sending` after
 * that). A page that hard-codes "Sent {date}" and a green "Sent" badge would
 * greet that with "Sent never", so the header states which of the five states
 * the campaign is actually in and the zero counts are explained rather than
 * left looking like a failed send.
 */
type ReportStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled';

const reportStatus = computed<ReportStatus>(() => {
	const status = campaign.value?.status;
	if (
		status === 'sent' ||
		status === 'sending' ||
		status === 'scheduled' ||
		status === 'cancelled'
	) {
		return status;
	}
	// `draft` and `pending_review` both mean "nothing has gone out".
	return 'draft';
});

const hasSendStarted = computed(
	() => reportStatus.value === 'sending' || reportStatus.value === 'sent'
);

/** In flight: the tiles are a live count, not a result to compare against. */
const isSendPending = computed(
	() => reportStatus.value === 'scheduled' || reportStatus.value === 'sending'
);

const statusBadge = computed(() => {
	const prefix = 'dashboard.campaigns.detail.report.status';
	switch (reportStatus.value) {
		case 'sent':
			return {
				label: t('dashboard.campaigns.detail.report.sentBadge'),
				icon: 'lucide:check-circle-2',
				tone: 'bg-success/10 text-success',
				spin: false,
			};
		case 'sending':
			return {
				label: t(`${prefix}.sending`),
				icon: 'lucide:loader-2',
				tone: 'bg-info/10 text-info',
				spin: true,
			};
		case 'scheduled':
			return {
				label: t(`${prefix}.scheduled`),
				icon: 'lucide:clock',
				tone: 'bg-info/10 text-info',
				spin: false,
			};
		case 'cancelled':
			return {
				label: t(`${prefix}.cancelled`),
				icon: 'lucide:x-circle',
				tone: 'bg-error/10 text-error',
				spin: false,
			};
		default:
			return {
				label: t(`${prefix}.draft`),
				icon: 'lucide:file-text',
				tone: 'bg-bg-elevated text-text-secondary',
				spin: false,
			};
	}
});

/** The one timing line under the title — whichever instant this state has. */
const timingLine = computed(() => {
	const prefix = 'dashboard.campaigns.detail.report';
	switch (reportStatus.value) {
		case 'sent':
			return t(`${prefix}.sentAt`, { date: formatDateTime(campaign.value?.sentAt) });
		case 'sending':
			return t(`${prefix}.startedAt`, { date: formatDateTime(campaign.value?.sentAt) });
		case 'scheduled':
			return t(`${prefix}.scheduledFor`, { date: formatDateTime(campaign.value?.scheduledAt) });
		case 'cancelled':
			return t(`${prefix}.cancelledLine`);
		default:
			return t(`${prefix}.notSentYet`);
	}
});

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

// The previous comparable campaign, for the comparison row -----------------
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

/** This send's counters in the shape the comparison row diffs. */
const currentSnapshot = computed(() => ({
	sent: sentCount.value,
	delivered: stats.value?.delivered ?? 0,
	opened: stats.value?.uniqueOpens ?? 0,
	clicked: stats.value?.uniqueClicks ?? 0,
	bounced: stats.value?.bounced ?? 0,
}));

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
		<UiQueryBoundary
			:loading="isLoading && !campaign"
			:error="campaignError"
			:error-title="t('dashboard.campaigns.detail.report.errorTitle')"
			:loading-label="t('dashboard.campaigns.detail.report.loadingLabel')"
			@retry="refetchCampaign"
		>
			<!-- Campaign Not Found -->
			<div
				v-if="!campaign"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox
					icon="lucide:bar-chart-3"
					size="xl"
					variant="surface"
					rounded="full"
					class="mb-4"
				/>
				<p class="text-text-secondary font-medium">
					{{ t('dashboard.campaigns.detail.report.notFoundTitle') }}
				</p>
				<p class="text-sm text-text-tertiary mt-1">
					{{ t('dashboard.campaigns.detail.report.notFoundDescription') }}
				</p>
				<UiButton variant="secondary" to="/dashboard/campaigns" class="mt-6">
					{{ t('dashboard.campaigns.detail.report.backToCampaigns') }}
				</UiButton>
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
						{{ t('dashboard.campaigns.detail.report.backToCampaigns') }}
					</NuxtLink>
					<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
						<div>
							<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
								{{ campaign.name }}
							</h1>
							<p
								class="mt-1 text-text-secondary text-sm flex flex-wrap items-center gap-x-2 gap-y-1"
							>
								<span class="inline-flex items-center gap-1.5">
									<Icon name="lucide:clock" class="w-4 h-4" />
									{{ timingLine }}
								</span>
								<!-- A recipient count before the first message is dispatched is
								     just a zero pretending to be information. -->
								<template v-if="hasSendStarted">
									<span class="text-text-tertiary">·</span>
									<span class="tabular-nums">
										{{
											t('dashboard.campaigns.detail.report.recipients', {
												count: formatNumber(sentCount),
											})
										}}
									</span>
								</template>
							</p>
							<!--
								THE MULTI-DAY SEND PLAN, present from the moment the send starts. Renders nothing for an ordinary same-day send.
							-->
							<CampaignSendPlanLine :progress="sendPlan" class="mt-1" />
						</div>
						<div class="flex items-center gap-3">
							<UiButton
								variant="secondary"
								class="gap-2"
								:disabled="isDuplicating"
								@click="handleDuplicate"
							>
								<Icon
									v-if="isDuplicating"
									name="lucide:loader-2"
									class="w-4 h-4 animate-spin motion-reduce:animate-none"
								/>
								<Icon v-else name="lucide:copy" class="w-4 h-4" />
								{{
									isDuplicating
										? t('dashboard.campaigns.detail.report.duplicating')
										: t('common.duplicate')
								}}
							</UiButton>
							<span
								:class="[
									'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
									statusBadge.tone,
								]"
							>
								<Icon
									:name="statusBadge.icon"
									:class="[
										'w-3 h-3',
										statusBadge.spin ? 'animate-spin motion-reduce:animate-none' : '',
									]"
								/>
								{{ statusBadge.label }}
							</span>
						</div>
					</div>
				</div>

				<!-- The story first: one sentence, then the funnel it comes from. -->
				<div v-if="(hasSendStarted || isSendPending) && stats" class="card p-4 sm:p-6 mb-8">
					<CampaignReportHeadline
						v-if="reportStatus === 'sent'"
						class="mb-5"
						:campaign-id="campaignId"
						:sent-at="campaign.sentAt"
						:current="{
							delivered: stats.delivered,
							opened: stats.uniqueOpens,
							clicked: stats.uniqueClicks,
							unsubscribed: campaign.statsUnsubscribed ?? 0,
						}"
						:comparables="comparableSends"
					/>
					<CampaignFunnel
						:sent="sentCount"
						:delivered="stats.delivered"
						:opened="stats.uniqueOpens"
						:clicked="stats.uniqueClicks"
						:unsubscribed="campaign.statsUnsubscribed ?? 0"
						:bounced="stats.bounced"
					/>
					<CampaignAutomatedOpensNote
						class="mt-3"
						:automated-opens="stats.automatedOpens"
						:is-automated-open-filtered="campaign.isAutomatedOpenFiltered === true"
					/>
					<!-- One comparison row with the previous campaign — rates only. -->
					<CampaignReportComparison
						class="mt-5 pt-4 border-t border-border-subtle"
						:current="currentSnapshot"
						:previous="previousComparable"
						:is-a-b-test="campaign.isABTest ?? false"
						:pending="isSendPending"
					/>
				</div>

				<!-- Archive Link -->
				<div v-if="archiveUrl" class="card p-4 mb-8">
					<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
						<div class="flex items-center gap-3 min-w-0">
							<UiIconBox icon="lucide:globe" size="sm" rounded="lg" />
							<div class="min-w-0">
								<p class="text-sm font-medium text-text-primary">
									{{ t('dashboard.campaigns.detail.report.archive.title') }}
								</p>
								<p class="text-xs text-text-tertiary truncate sm:max-w-md">{{ archiveUrl }}</p>
							</div>
						</div>
						<UiButton
							variant="secondary"
							class="text-sm gap-1.5 self-start sm:self-auto shrink-0"
							@click="copyArchiveLink"
						>
							<Icon :name="archiveCopied ? 'lucide:check' : 'lucide:copy'" class="w-3.5 h-3.5" />
							{{
								archiveCopied
									? t('common.copied')
									: t('dashboard.campaigns.detail.report.archive.copyLink')
							}}
						</UiButton>
					</div>
				</div>

				<!-- A/B Test fold-in -->
				<div v-if="campaign.isABTest && abTestStats" class="mb-8">
					<CampaignAbComparison
						:stats="abTestStats"
						:is-selecting-winner="isSelectingWinner"
						@select-winner="handleSelectWinner"
					/>
				</div>

				<!-- Opens Timeline -->
				<div class="card p-4 sm:p-6 mb-8">
					<div class="flex items-baseline justify-between mb-6">
						<h3 class="text-base font-medium text-text-primary">
							{{ t('dashboard.campaigns.detail.report.timeline.title') }}
						</h3>
						<span class="text-xs text-text-tertiary">{{
							t('dashboard.campaigns.detail.report.timeline.window')
						}}</span>
					</div>

					<!-- Empty state -->
					<div
						v-if="timelineData.length === 0"
						class="flex flex-col items-center justify-center py-12 text-center"
					>
						<Icon name="lucide:eye" class="w-10 h-10 text-text-tertiary mb-3" />
						<p class="text-text-secondary">
							{{ t('dashboard.campaigns.detail.report.timeline.emptyTitle') }}
						</p>
						<p class="text-sm text-text-tertiary mt-1">
							{{ t('dashboard.campaigns.detail.report.timeline.emptyDescription') }}
						</p>
					</div>

					<UiTrendChart
						v-else
						:data="timelineData"
						label-peak
						:format-value="(v: number) => formatNumber(v)"
						:aria-label="t('dashboard.campaigns.detail.report.timeline.chartLabel')"
					/>
				</div>

				<!-- Click Heatmap -->
				<div v-if="campaign?.emailTemplate?.htmlContent" class="card p-4 sm:p-6 mb-8">
					<div class="flex items-center gap-3 mb-6">
						<UiIconBox icon="lucide:flame" size="sm" variant="warning" rounded="lg" />
						<div>
							<h3 class="text-base font-medium text-text-primary">
								{{ t('dashboard.campaigns.detail.report.heatmap.title') }}
							</h3>
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.campaigns.detail.report.heatmap.subtitle') }}
							</p>
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
								'flex-1 px-3 sm:px-6 py-4 text-sm transition-colors duration-(--motion-fast) flex items-center justify-center gap-2',
								selectedTab === 'opened'
									? 'text-text-primary font-semibold border-b-2 border-brand'
									: 'text-text-secondary font-medium hover:text-text-primary',
							]"
							@click="selectedTab = 'opened'"
						>
							<Icon name="lucide:eye" class="w-4 h-4" />
							{{
								t('dashboard.campaigns.detail.report.tabs.opened', {
									count: openedContacts?.total || 0,
								})
							}}
						</button>
						<button
							:class="[
								'flex-1 px-3 sm:px-6 py-4 text-sm transition-colors duration-(--motion-fast) flex items-center justify-center gap-2',
								selectedTab === 'clicked'
									? 'text-text-primary font-semibold border-b-2 border-brand'
									: 'text-text-secondary font-medium hover:text-text-primary',
							]"
							@click="selectedTab = 'clicked'"
						>
							<Icon name="lucide:mouse-pointer-click" class="w-4 h-4" />
							{{
								t('dashboard.campaigns.detail.report.tabs.clicked', {
									count: clickedContacts?.total || 0,
								})
							}}
						</button>
					</div>

					<!-- Opened Contacts Tab -->
					<div v-if="selectedTab === 'opened'">
						<div v-if="openedLoading && !openedContacts" class="p-8 flex justify-center">
							<Icon
								name="lucide:loader-2"
								class="w-6 h-6 text-brand animate-spin motion-reduce:animate-none"
							/>
						</div>

						<div
							v-else-if="!openedContacts || openedContacts.sends.length === 0"
							class="py-12 text-center"
						>
							<Icon name="lucide:eye" class="w-10 h-10 text-text-tertiary mx-auto mb-3" />
							<p class="text-text-secondary">
								{{ t('dashboard.campaigns.detail.report.openedEmpty') }}
							</p>
						</div>

						<div v-else>
							<div class="divide-y divide-border-subtle">
								<div
									v-for="send in openedContacts.sends"
									:key="send._id"
									class="px-4 sm:px-6 py-4 flex items-center justify-between hover:bg-bg-surface transition-colors duration-(--motion-fast)"
								>
									<div class="flex items-center gap-3 min-w-0">
										<UiIconBox icon="lucide:users" size="sm" rounded="full" />
										<div class="min-w-0">
											<div class="text-text-primary font-medium truncate">
												{{
													send.contact?.firstName ||
													send.contact?.email?.split('@')[0] ||
													t('common.unknown')
												}}
												{{ send.contact?.lastName || '' }}
											</div>
											<div class="text-sm text-text-tertiary truncate">
												{{ send.contact?.email || t('dashboard.campaigns.detail.report.noEmail') }}
											</div>
										</div>
									</div>
									<div class="flex items-center gap-4 shrink-0">
										<div class="text-right">
											<div class="text-sm text-text-secondary">
												{{ formatCompactRelativeTime(send.openedAt, { emptyLabel: '—' }) }}
											</div>
											<div
												v-if="send.openCount > 1"
												class="text-xs text-text-tertiary tabular-nums"
											>
												{{
													t('dashboard.campaigns.detail.report.opensCount', {
														count: send.openCount,
													})
												}}
											</div>
										</div>
										<NuxtLink
											:to="`/dashboard/campaigns/${campaignId}/sends/${send._id}`"
											class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
											:title="t('dashboard.campaigns.detail.report.viewSendDetails')"
										>
											<Icon name="lucide:chevron-right" class="w-4 h-4" />
										</NuxtLink>
									</div>
								</div>
							</div>

							<div
								v-if="openedContacts.total > pageSize"
								class="px-4 sm:px-6 py-4 border-t border-border-subtle flex items-center justify-between gap-3"
							>
								<UiButton
									variant="secondary"
									class="text-sm"
									:disabled="openedOffset === 0"
									@click="loadPrevOpened"
								>
									{{ t('dashboard.campaigns.detail.report.pagination.previous') }}
								</UiButton>
								<span class="text-sm text-text-tertiary tabular-nums">
									{{
										t('dashboard.campaigns.detail.report.pagination.range', {
											from: openedOffset + 1,
											to: Math.min(openedOffset + pageSize, openedContacts.total),
											total: openedContacts.total,
										})
									}}
								</span>
								<UiButton
									variant="secondary"
									class="text-sm"
									:disabled="!openedContacts.hasMore"
									@click="loadMoreOpened"
								>
									{{ t('dashboard.campaigns.detail.report.pagination.next') }}
								</UiButton>
							</div>
						</div>
					</div>

					<!-- Clicked Contacts Tab -->
					<div v-if="selectedTab === 'clicked'">
						<div v-if="clickedLoading && !clickedContacts" class="p-8 flex justify-center">
							<Icon
								name="lucide:loader-2"
								class="w-6 h-6 text-brand animate-spin motion-reduce:animate-none"
							/>
						</div>

						<div
							v-else-if="!clickedContacts || clickedContacts.sends.length === 0"
							class="py-12 text-center"
						>
							<Icon
								name="lucide:mouse-pointer-click"
								class="w-10 h-10 text-text-tertiary mx-auto mb-3"
							/>
							<p class="text-text-secondary">
								{{ t('dashboard.campaigns.detail.report.clickedEmpty') }}
							</p>
						</div>

						<div v-else>
							<div class="divide-y divide-border-subtle">
								<div
									v-for="send in clickedContacts.sends"
									:key="send._id"
									class="px-4 sm:px-6 py-4 hover:bg-bg-surface transition-colors duration-(--motion-fast)"
								>
									<div class="flex items-center justify-between">
										<div class="flex items-center gap-3 min-w-0">
											<UiIconBox icon="lucide:users" size="sm" variant="warning" rounded="full" />
											<div class="min-w-0">
												<div class="text-text-primary font-medium truncate">
													{{
														send.contact?.firstName ||
														send.contact?.email?.split('@')[0] ||
														t('common.unknown')
													}}
													{{ send.contact?.lastName || '' }}
												</div>
												<div class="text-sm text-text-tertiary truncate">
													{{
														send.contact?.email || t('dashboard.campaigns.detail.report.noEmail')
													}}
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
													{{
														t(
															'dashboard.campaigns.detail.report.linksCount',
															{ count: send.clickedLinks.length },
															send.clickedLinks.length
														)
													}}
												</div>
											</div>
											<NuxtLink
												:to="`/dashboard/campaigns/${campaignId}/sends/${send._id}`"
												class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
												:title="t('dashboard.campaigns.detail.report.viewSendDetails')"
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
											{{
												t('dashboard.campaigns.detail.report.moreLinks', {
													count: send.clickedLinks.length - 3,
												})
											}}
										</div>
									</div>
								</div>
							</div>

							<div
								v-if="clickedContacts.total > pageSize"
								class="px-4 sm:px-6 py-4 border-t border-border-subtle flex items-center justify-between gap-3"
							>
								<UiButton
									variant="secondary"
									class="text-sm"
									:disabled="clickedOffset === 0"
									@click="loadPrevClicked"
								>
									{{ t('dashboard.campaigns.detail.report.pagination.previous') }}
								</UiButton>
								<span class="text-sm text-text-tertiary tabular-nums">
									{{
										t('dashboard.campaigns.detail.report.pagination.range', {
											from: clickedOffset + 1,
											to: Math.min(clickedOffset + pageSize, clickedContacts.total),
											total: clickedContacts.total,
										})
									}}
								</span>
								<UiButton
									variant="secondary"
									class="text-sm"
									:disabled="!clickedContacts.hasMore"
									@click="loadMoreClicked"
								>
									{{ t('dashboard.campaigns.detail.report.pagination.next') }}
								</UiButton>
							</div>
						</div>
					</div>
				</div>
			</div>
		</UiQueryBoundary>

		<!--
			The send this page was navigated to by may still be inside its undo
			window. The toast is mounted here because this is where sending lands.
		-->
		<CampaignsUndoSendToast />
	</div>
</template>
