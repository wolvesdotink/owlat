<script setup lang="ts">
/**
 * Marketing overview — first how it went, then what's next.
 *
 * Three bands in a fixed order: the latest campaigns, all campaigns over the
 * last 30 days, and Next up. Nothing actionable sits above the performance
 * bands; the header's quiet "N to do" chip jumps down to band 3 instead. Before
 * the first send, bands 1 and 2 collapse into one explanatory card and Next up
 * is the page.
 */
import { api } from '@owlat/api';
import MarketingAudiencePanel from '~/components/marketing/MarketingAudiencePanel.vue';
import MarketingLatestCampaigns from '~/components/marketing/MarketingLatestCampaigns.vue';
import MarketingNextUp from '~/components/marketing/MarketingNextUp.vue';
import MarketingPeriodTiles from '~/components/marketing/MarketingPeriodTiles.vue';
import MarketingRateBars from '~/components/marketing/MarketingRateBars.vue';
import { formatNumber } from '~/utils/formatters';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.marketing.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'campaigns',
});

const router = useRouter();

const {
	data: overview,
	isLoading: overviewLoading,
	error: overviewError,
} = useOrganizationQuery(api.analytics.marketingOverview.get);

const {
	needsYou,
	scheduled,
	scheduledTotal,
	drafts,
	todoCount,
	isUrgent,
	isLoading: nextUpLoading,
	error: nextUpError,
} = useMarketingNextUp();

const isFirstRun = computed(
	() =>
		!!overview.value &&
		overview.value.latest.length === 0 &&
		overview.value.recent.campaigns.length === 0
);

const dayLabel = computed(
	() => new Intl.DateTimeFormat(locale.value, { month: 'short', day: 'numeric', timeZone: 'UTC' })
);

const opensSeries = computed(() =>
	(overview.value?.opensPerDay ?? []).map((d) => ({
		label: dayLabel.value.format(new Date(`${d.date}T00:00:00Z`)),
		value: d.opened,
	}))
);

const openBars = computed(() =>
	(overview.value?.recent.campaigns ?? []).map((c) => ({
		id: c.id,
		label: c.name,
		value: c.openRate,
	}))
);
const clickBars = computed(() =>
	(overview.value?.recent.campaigns ?? []).map((c) => ({
		id: c.id,
		label: c.name,
		value: c.clickRate,
	}))
);

function scrollToNextUp() {
	document.getElementById('next-up')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function handleNewCampaign() {
	router.push('/dashboard/campaigns/new');
}
</script>

<template>
	<div class="p-6 lg:p-8">
		<UiPageHeader :title="t('dashboard.marketing.title')" class="mb-8">
			<template #actions>
				<button
					v-if="todoCount > 0 && !isFirstRun"
					type="button"
					:class="[
						'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium tabular-nums transition-colors duration-(--motion-fast)',
						isUrgent
							? 'bg-warning/10 text-warning'
							: 'bg-bg-surface text-text-secondary hover:text-text-primary',
					]"
					@click="scrollToNextUp"
				>
					<Icon v-if="isUrgent" name="lucide:alert-triangle" class="w-3 h-3" aria-hidden="true" />
					{{ t('dashboard.marketing.todoChip', { count: todoCount }) }}
					<Icon name="lucide:arrow-down" class="w-3 h-3" aria-hidden="true" />
				</button>
				<!-- The top bar's primary already says New campaign on large screens in
				     the Marketing workspace; this copy is for phones, whose top bar has
				     no create button. -->
				<UiButton class="lg:hidden" @click="handleNewCampaign">
					<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
					{{ t('dashboard.marketing.newCampaign') }}
				</UiButton>
			</template>
		</UiPageHeader>

		<UiErrorAlert
			v-if="overviewError"
			:title="t('dashboard.marketing.errorTitle')"
			:message="t('dashboard.marketing.errorMessage')"
			class="mb-8"
		/>

		<!-- Loading: the two performance bands at their final geometry. -->
		<div v-else-if="overviewLoading && !overview" class="space-y-10" aria-busy="true">
			<section>
				<UiSkeleton class="h-5 w-48 mb-4" />
				<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
					<div v-for="i in 3" :key="i" class="card p-5 h-44">
						<UiSkeleton class="h-4 w-2/3" />
						<UiSkeleton class="h-3 w-1/2 mt-2" />
						<UiSkeleton class="h-3 w-full mt-4" />
						<div class="grid grid-cols-3 gap-2 mt-6">
							<UiSkeleton v-for="j in 3" :key="j" class="h-8" />
						</div>
					</div>
				</div>
			</section>
			<section>
				<UiSkeleton class="h-5 w-56 mb-4" />
				<div class="card p-6">
					<div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-6">
						<UiSkeleton v-for="i in 5" :key="i" class="h-20" />
					</div>
				</div>
				<div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
					<UiSkeleton class="h-56 lg:col-span-2" />
					<UiSkeleton class="h-56" />
				</div>
			</section>
		</div>

		<!-- First run: one card instead of two empty bands. -->
		<UiCard v-else-if="isFirstRun" padding="none" overflow="hidden" class="mb-10">
			<UiEmptyState
				icon="lucide:bar-chart-3"
				:title="t('dashboard.marketing.firstRun.title')"
				:description="t('dashboard.marketing.firstRun.description')"
			>
				<template #action>
					<UiButton @click="handleNewCampaign">
						<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
						{{ t('dashboard.marketing.newCampaign') }}
					</UiButton>
				</template>
			</UiEmptyState>
		</UiCard>

		<template v-else-if="overview">
			<!-- Band 1: latest campaigns -->
			<section class="mb-10" aria-labelledby="band-latest">
				<div class="mb-4">
					<h2 id="band-latest" class="text-base font-medium text-text-primary">
						{{ t('dashboard.marketing.latest.title') }}
					</h2>
					<p class="text-xs text-text-tertiary">
						{{
							t('dashboard.marketing.latest.subtitle', {
								count: overview.recent.campaigns.length,
							})
						}}
					</p>
				</div>
				<MarketingLatestCampaigns :campaigns="overview.latest" :recent="overview.recent" />
			</section>

			<!-- Band 2: all campaigns, last 30 days -->
			<section class="mb-10" aria-labelledby="band-period">
				<div class="mb-4">
					<h2 id="band-period" class="text-base font-medium text-text-primary">
						{{ t('dashboard.marketing.period.title') }}
					</h2>
					<p class="text-xs text-text-tertiary tabular-nums">
						{{
							t('dashboard.marketing.period.subtitle', {
								campaigns: overview.period.campaignCount,
								delivered: formatNumber(overview.period.current.delivered),
							})
						}}
					</p>
				</div>

				<div class="card p-4 sm:p-6">
					<MarketingPeriodTiles :period="overview.period" />
				</div>

				<div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
					<div class="card p-4 sm:p-6 lg:col-span-2">
						<h3 class="text-sm font-medium text-text-primary">
							{{ t('dashboard.marketing.period.opensPerDay') }}
						</h3>
						<p class="text-xs text-text-tertiary mb-4">
							{{ t('dashboard.marketing.period.opensPerDayNote') }}
						</p>
						<UiTrendChart
							:data="opensSeries"
							:ariaLabel="t('dashboard.marketing.period.opensPerDay')"
							:format-value="(v: number) => formatNumber(Math.round(v))"
							label-peak
						/>
					</div>
					<div class="card p-4 sm:p-6">
						<h3 class="text-sm font-medium text-text-primary mb-4">
							{{ t('dashboard.marketing.period.audience') }}
						</h3>
						<MarketingAudiencePanel :delivery="overview.delivery" />
					</div>
				</div>

				<div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
					<div class="card p-4 sm:p-6">
						<h3 class="text-sm font-medium text-text-primary">
							{{ t('dashboard.marketing.period.openRateByCampaign') }}
						</h3>
						<p class="text-xs text-text-tertiary mb-4">
							{{ t('dashboard.marketing.period.byCampaignNote') }}
						</p>
						<MarketingRateBars
							:bars="openBars"
							:average="overview.recent.average.openRate"
							:ariaLabel="t('dashboard.marketing.period.openRateByCampaign')"
						/>
					</div>
					<div class="card p-4 sm:p-6">
						<h3 class="text-sm font-medium text-text-primary">
							{{ t('dashboard.marketing.period.clickRateByCampaign') }}
						</h3>
						<p class="text-xs text-text-tertiary mb-4">
							{{ t('dashboard.marketing.period.sameOrderNote') }}
						</p>
						<MarketingRateBars
							:bars="clickBars"
							:average="overview.recent.average.clickRate"
							:ariaLabel="t('dashboard.marketing.period.clickRateByCampaign')"
						/>
					</div>
				</div>
			</section>
		</template>

		<!-- Band 3: next up -->
		<section id="next-up" class="scroll-mt-6" aria-labelledby="band-next-up">
			<div class="mb-4">
				<h2 id="band-next-up" class="text-base font-medium text-text-primary">
					{{ t('dashboard.marketing.nextUp.title') }}
				</h2>
				<p class="text-xs text-text-tertiary">{{ t('dashboard.marketing.nextUp.subtitle') }}</p>
			</div>
			<UiErrorAlert
				v-if="nextUpError"
				:title="t('dashboard.marketing.nextUp.errorTitle')"
				:message="t('dashboard.marketing.errorMessage')"
			/>
			<div v-else-if="nextUpLoading" class="grid grid-cols-1 lg:grid-cols-3 gap-4" aria-busy="true">
				<div v-for="i in 3" :key="i" class="card p-5">
					<UiSkeleton class="h-4 w-24" />
					<UiSkeleton v-for="j in 3" :key="j" class="h-9 w-full mt-3" />
				</div>
			</div>
			<MarketingNextUp
				v-else
				:needs-you="needsYou"
				:scheduled="scheduled"
				:scheduled-total="scheduledTotal"
				:drafts="drafts"
			/>
		</section>
	</div>
</template>
