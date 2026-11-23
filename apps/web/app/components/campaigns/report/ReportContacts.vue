<script setup lang="ts">
// The campaign report's contacts card: the Opened / Clicked / Failed / Bounced
// tabs and the page of contacts under the active one. This section owns the
// queries and the offsets; the page may choose the tab (the failure line's
// "Show who" does).
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import CampaignReportClickedList from '~/components/campaigns/report/ReportClickedList.vue';
import CampaignReportOpenedList from '~/components/campaigns/report/ReportOpenedList.vue';
import CampaignReportUndeliveredList from '~/components/campaigns/report/ReportUndeliveredList.vue';
import { formatNumber } from '~/utils/formatters';
import {
	CircleCloseIcon,
	CursorClickIcon,
	EyeIcon,
	TriangleWarningIcon,
	type IconComponent,
} from '@coolicons/vue';

export type ContactTab = 'opened' | 'clicked' | 'failed' | 'bounced';

const props = defineProps<{
	campaignId: Id<'campaigns'>;
	/** The campaign's own totals, shown on a tab until its list has loaded. */
	uniqueOpens: number | undefined;
	uniqueClicks: number | undefined;
	failedCount: number | undefined;
	bouncedCount: number | undefined;
}>();

const selectedTab = defineModel<ContactTab>('tab', { default: 'opened' });

const { t } = useI18n();

const pageSize = 10;
const offsets = ref<Record<ContactTab, number>>({ opened: 0, clicked: 0, failed: 0, bounced: 0 });

// Only the active tab's list is read; the others are skipped until chosen.
const pageArgs = (tab: ContactTab) => () =>
	selectedTab.value === tab
		? { campaignId: props.campaignId, limit: pageSize, offset: offsets.value[tab] }
		: ('skip' as const);

const opened = useConvexQuery(api.delivery.sends.getOpenedContacts, pageArgs('opened'));
const clicked = useConvexQuery(api.delivery.sends.getClickedContacts, pageArgs('clicked'));
const undeliveredArgs = (tab: 'failed' | 'bounced') => () => {
	const args = pageArgs(tab)();
	return args === 'skip' ? args : { ...args, status: tab };
};
const failed = useConvexQuery(
	api.delivery.sendFailures.getUndeliveredContacts,
	undeliveredArgs('failed')
);
const bounced = useConvexQuery(
	api.delivery.sendFailures.getUndeliveredContacts,
	undeliveredArgs('bounced')
);

const queries = { opened, clicked, failed, bounced };

// The inactive tabs' lists are skipped, so their counts come from the
// campaign's own totals until the list has loaded.
const counts = computed<Record<ContactTab, number>>(() => ({
	opened: opened.data.value?.total ?? props.uniqueOpens ?? 0,
	clicked: clicked.data.value?.total ?? props.uniqueClicks ?? 0,
	failed: failed.data.value?.total ?? props.failedCount ?? 0,
	bounced: bounced.data.value?.total ?? props.bouncedCount ?? 0,
}));

const TAB_ICONS: Record<ContactTab, IconComponent> = {
	opened: EyeIcon,
	clicked: CursorClickIcon,
	failed: TriangleWarningIcon,
	bounced: CircleCloseIcon,
};

// Failed and Bounced appear only when there is something in them, so a report
// where every send arrived keeps its two tabs.
const tabs = computed<ContactTab[]>(() =>
	(['opened', 'clicked', 'failed', 'bounced'] as const).filter(
		(tab) =>
			tab === 'opened' || tab === 'clicked' || counts.value[tab] > 0 || selectedTab.value === tab
	)
);

const contactTabId = (tab: ContactTab) => `campaign-report-tab-${tab}`;
const contactTabRefs: Partial<Record<ContactTab, HTMLButtonElement | null>> = {};
const onContactTabKeydown = (event: KeyboardEvent) => {
	const list = tabs.value;
	const index = list.indexOf(selectedTab.value);
	let next: number | null = null;
	const count = list.length;
	if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % count;
	else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + count) % count;
	else if (event.key === 'Home') next = 0;
	else if (event.key === 'End') next = count - 1;
	if (next === null) return;
	event.preventDefault();
	const tab = list[next]!;
	selectedTab.value = tab;
	contactTabRefs[tab]?.focus();
};

const loadNext = (tab: ContactTab) => {
	if (queries[tab].data.value?.hasMore) offsets.value[tab] += pageSize;
};
const loadPrevious = (tab: ContactTab) => {
	offsets.value[tab] = Math.max(0, offsets.value[tab] - pageSize);
};

const active = computed(() => queries[selectedTab.value]);
const undeliveredTab = computed(() =>
	selectedTab.value === 'failed' || selectedTab.value === 'bounced' ? selectedTab.value : null
);
const undeliveredQuery = computed(() => (undeliveredTab.value === 'bounced' ? bounced : failed));
</script>

<template>
	<div class="card p-0 overflow-hidden">
		<!-- Tabs -->
		<div
			role="tablist"
			class="flex overflow-x-auto border-b border-border-subtle"
			@keydown="onContactTabKeydown"
		>
			<button
				v-for="tab in tabs"
				:id="contactTabId(tab)"
				:key="tab"
				:ref="(el) => (contactTabRefs[tab] = el as HTMLButtonElement | null)"
				type="button"
				role="tab"
				:aria-selected="selectedTab === tab"
				aria-controls="campaign-report-contacts"
				:tabindex="selectedTab === tab ? 0 : -1"
				:class="[
					'flex-1 whitespace-nowrap px-3 sm:px-6 py-4 text-sm transition-colors duration-(--motion-fast) flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
					selectedTab === tab
						? 'text-text-primary font-semibold border-b-2 border-brand'
						: 'text-text-secondary font-medium hover:text-text-primary',
				]"
				@click="selectedTab = tab"
			>
				<component :is="TAB_ICONS[tab]" class="w-4 h-4" aria-hidden="true" />
				{{
					t(`dashboard.campaigns.detail.report.tabs.${tab}`, {
						count: formatNumber(counts[tab]),
					})
				}}
			</button>
		</div>

		<div id="campaign-report-contacts" role="tabpanel" :aria-labelledby="contactTabId(selectedTab)">
			<!-- A failed read is not "nobody opened / clicked / failed". -->
			<UiQueryBoundary
				v-if="active.error.value"
				:error="active.error.value"
				@retry="active.refetch"
			/>
			<CampaignReportOpenedList
				v-else-if="selectedTab === 'opened'"
				:campaign-id="campaignId"
				:contacts="opened.data.value"
				:loading="opened.isLoading.value"
				:offset="offsets.opened"
				:page-size="pageSize"
				@previous="loadPrevious('opened')"
				@next="loadNext('opened')"
			/>
			<CampaignReportClickedList
				v-else-if="selectedTab === 'clicked'"
				:campaign-id="campaignId"
				:contacts="clicked.data.value"
				:loading="clicked.isLoading.value"
				:offset="offsets.clicked"
				:page-size="pageSize"
				@previous="loadPrevious('clicked')"
				@next="loadNext('clicked')"
			/>
			<CampaignReportUndeliveredList
				v-else-if="undeliveredTab"
				:key="undeliveredTab"
				:campaign-id="campaignId"
				:kind="undeliveredTab"
				:contacts="undeliveredQuery.data.value"
				:loading="undeliveredQuery.isLoading.value"
				:offset="offsets[undeliveredTab]"
				:page-size="pageSize"
				@previous="loadPrevious(undeliveredTab)"
				@next="loadNext(undeliveredTab)"
			/>
		</div>
	</div>
</template>
