<script setup lang="ts">
// The campaign report's contacts card: the Opened / Clicked tabs and the page
// of contacts under the active one. This section owns the tab, the queries and
// the offsets.
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import CampaignReportClickedList from '~/components/campaigns/report/ReportClickedList.vue';
import CampaignReportOpenedList from '~/components/campaigns/report/ReportOpenedList.vue';
import { formatNumber } from '~/utils/formatters';
import { CursorClickIcon, EyeIcon } from '@coolicons/vue';

const props = defineProps<{
	campaignId: Id<'campaigns'>;
	/** The campaign's own totals, shown on a tab until its list has loaded. */
	uniqueOpens: number | undefined;
	uniqueClicks: number | undefined;
}>();

const { t } = useI18n();

// Tab state for contacts list
type ContactTab = 'opened' | 'clicked';
const selectedTab = ref<ContactTab>('opened');

// Pagination state
const openedOffset = ref(0);
const clickedOffset = ref(0);
const pageSize = 10;

// Fetch contacts who opened / clicked — only the active tab's list scans
// emailSends; the other is skipped until its tab is selected.
const {
	data: openedContacts,
	isLoading: openedLoading,
	error: openedError,
	refetch: refetchOpened,
} = useConvexQuery(api.delivery.sends.getOpenedContacts, () =>
	selectedTab.value === 'opened'
		? { campaignId: props.campaignId, limit: pageSize, offset: openedOffset.value }
		: 'skip'
);

const {
	data: clickedContacts,
	isLoading: clickedLoading,
	error: clickedError,
	refetch: refetchClicked,
} = useConvexQuery(api.delivery.sends.getClickedContacts, () =>
	selectedTab.value === 'clicked'
		? { campaignId: props.campaignId, limit: pageSize, offset: clickedOffset.value }
		: 'skip'
);

// The inactive tab's list is skipped until it is chosen, so its count comes
// from the campaign's own totals until the list has loaded.
const openedCount = computed(() => openedContacts.value?.total ?? props.uniqueOpens ?? 0);
const clickedCount = computed(() => clickedContacts.value?.total ?? props.uniqueClicks ?? 0);

const CONTACT_TABS: ContactTab[] = ['opened', 'clicked'];
const contactTabId = (tab: ContactTab) => `campaign-report-tab-${tab}`;
const contactTabRefs: Partial<Record<ContactTab, HTMLButtonElement | null>> = {};
const onContactTabKeydown = (event: KeyboardEvent) => {
	const index = CONTACT_TABS.indexOf(selectedTab.value);
	let next: number | null = null;
	const count = CONTACT_TABS.length;
	if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % count;
	else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + count) % count;
	else if (event.key === 'Home') next = 0;
	else if (event.key === 'End') next = count - 1;
	if (next === null) return;
	event.preventDefault();
	const tab = CONTACT_TABS[next]!;
	selectedTab.value = tab;
	contactTabRefs[tab]?.focus();
};

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
	<div class="card p-0 overflow-hidden">
		<!-- Tabs -->
		<div role="tablist" class="flex border-b border-border-subtle" @keydown="onContactTabKeydown">
			<button
				:id="contactTabId('opened')"
				:ref="(el) => (contactTabRefs.opened = el as HTMLButtonElement | null)"
				type="button"
				role="tab"
				:aria-selected="selectedTab === 'opened'"
				aria-controls="campaign-report-contacts"
				:tabindex="selectedTab === 'opened' ? 0 : -1"
				:class="[
					'flex-1 px-3 sm:px-6 py-4 text-sm transition-colors duration-(--motion-fast) flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
					selectedTab === 'opened'
						? 'text-text-primary font-semibold border-b-2 border-brand'
						: 'text-text-secondary font-medium hover:text-text-primary',
				]"
				@click="selectedTab = 'opened'"
			>
				<EyeIcon class="w-4 h-4" aria-hidden="true" />
				{{
					t('dashboard.campaigns.detail.report.tabs.opened', {
						count: formatNumber(openedCount),
					})
				}}
			</button>
			<button
				:id="contactTabId('clicked')"
				:ref="(el) => (contactTabRefs.clicked = el as HTMLButtonElement | null)"
				type="button"
				role="tab"
				:aria-selected="selectedTab === 'clicked'"
				aria-controls="campaign-report-contacts"
				:tabindex="selectedTab === 'clicked' ? 0 : -1"
				:class="[
					'flex-1 px-3 sm:px-6 py-4 text-sm transition-colors duration-(--motion-fast) flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
					selectedTab === 'clicked'
						? 'text-text-primary font-semibold border-b-2 border-brand'
						: 'text-text-secondary font-medium hover:text-text-primary',
				]"
				@click="selectedTab = 'clicked'"
			>
				<CursorClickIcon class="w-4 h-4" aria-hidden="true" />
				{{
					t('dashboard.campaigns.detail.report.tabs.clicked', {
						count: formatNumber(clickedCount),
					})
				}}
			</button>
		</div>

		<div id="campaign-report-contacts" role="tabpanel" :aria-labelledby="contactTabId(selectedTab)">
			<!-- A failed read is not "nobody opened / clicked". -->
			<UiQueryBoundary
				v-if="selectedTab === 'opened' && openedError"
				:error="openedError"
				@retry="refetchOpened"
			/>
			<!-- Opened Contacts Tab -->
			<CampaignReportOpenedList
				v-else-if="selectedTab === 'opened'"
				:campaign-id="campaignId"
				:contacts="openedContacts"
				:loading="openedLoading"
				:offset="openedOffset"
				:page-size="pageSize"
				@previous="loadPrevOpened"
				@next="loadMoreOpened"
			/>

			<UiQueryBoundary
				v-if="selectedTab === 'clicked' && clickedError"
				:error="clickedError"
				@retry="refetchClicked"
			/>
			<!-- Clicked Contacts Tab -->
			<CampaignReportClickedList
				v-else-if="selectedTab === 'clicked'"
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
</template>
