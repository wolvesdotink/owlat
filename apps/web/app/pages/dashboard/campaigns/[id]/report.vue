<script setup lang="ts">
import { api } from '@owlat/api';
import ClickHeatmap from '~/components/dashboard/ClickHeatmap.vue';
import CampaignAbComparison from '~/components/dashboard/CampaignAbComparison.vue';
import CampaignAutomatedEngagementNote from '~/components/campaigns/CampaignAutomatedEngagementNote.vue';
import CampaignFunnel from '~/components/campaigns/CampaignFunnel.vue';
import CampaignReportHeadline from '~/components/campaigns/CampaignReportHeadline.vue';
import CampaignReportComparison from '~/components/campaigns/CampaignReportComparison.vue';
import CampaignSendTimeReport from '~/components/campaigns/CampaignSendTimeReport.vue';
import CampaignReportArchiveLink from '~/components/campaigns/report/ReportArchiveLink.vue';
import CampaignReportClickedList from '~/components/campaigns/report/ReportClickedList.vue';
import CampaignReportHeader from '~/components/campaigns/report/ReportHeader.vue';
import CampaignReportOpenedList from '~/components/campaigns/report/ReportOpenedList.vue';
import CampaignReportOpensTimeline from '~/components/campaigns/report/ReportOpensTimeline.vue';
import { selectPreviousComparable } from '~/utils/campaignReport';
import { formatNumber } from '~/utils/formatters';
import { useRecordPaletteObjectOpen } from '~/composables/useCommandPaletteObjectRecents';

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
// ⌘K's "Jump back" list remembers the campaign once it has a name.
useRecordPaletteObjectOpen(() =>
	campaign.value?.name
		? { kind: 'campaign', id: campaignId.value, title: campaign.value.name }
		: null
);

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

// Archive link
const config = useRuntimeConfig();
const archiveUrl = computed(() => {
	if (!campaign.value?.archiveToken) return null;
	const siteUrl = config.public.siteUrl || window.location.origin;
	return `${siteUrl}/archive?token=${campaign.value.archiveToken}`;
});

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
	<div class="mx-auto w-full max-w-page p-6 lg:p-8">
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
				<CampaignReportHeader
					:campaign="campaign"
					:report-status="reportStatus"
					:has-send-started="hasSendStarted"
					:sent-count="sentCount"
					:send-plan="sendPlan"
					:is-duplicating="isDuplicating"
					@duplicate="handleDuplicate"
				/>

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
					<CampaignAutomatedEngagementNote
						class="mt-3"
						:automated-opens="stats.automatedOpens"
						:is-automated-open-filtered="campaign.isAutomatedOpenFiltered === true"
						:automated-clicks="stats.automatedClicks"
						:is-automated-click-filtered="campaign.isAutomatedClickFiltered === true"
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
				<CampaignReportArchiveLink v-if="archiveUrl" :archive-url="archiveUrl" />

				<!-- A/B Test fold-in -->
				<div v-if="campaign.isABTest && abTestStats" class="mb-8">
					<CampaignAbComparison
						:stats="abTestStats"
						:is-selecting-winner="isSelectingWinner"
						@select-winner="handleSelectWinner"
					/>
				</div>

				<!-- Send-time optimization: optimized contacts against the comparison group -->
				<CampaignSendTimeReport
					v-if="campaign.sendTimeOptimization && hasSendStarted"
					class="mb-8"
					:campaign="campaign"
				/>

				<!-- Opens Timeline -->
				<CampaignReportOpensTimeline :opens-timeline="opensTimeline" />

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
									count: formatNumber(openedContacts?.total ?? 0),
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
									count: formatNumber(clickedContacts?.total ?? 0),
								})
							}}
						</button>
					</div>

					<!-- Opened Contacts Tab -->
					<CampaignReportOpenedList
						v-if="selectedTab === 'opened'"
						:campaign-id="campaignId"
						:contacts="openedContacts"
						:loading="openedLoading"
						:offset="openedOffset"
						:page-size="pageSize"
						@previous="loadPrevOpened"
						@next="loadMoreOpened"
					/>

					<!-- Clicked Contacts Tab -->
					<CampaignReportClickedList
						v-if="selectedTab === 'clicked'"
						:campaign-id="campaignId"
						:contacts="clickedContacts"
						:loading="clickedLoading"
						:offset="clickedOffset"
						:page-size="pageSize"
						@previous="loadPrevClicked"
						@next="loadMoreClicked"
					/>
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
