<script setup lang="ts">
import { api } from '@owlat/api';
import { formatNumber } from '~/utils/formatters';

const { t, locale } = useI18n();

const { data: stats, isLoading } = useOrganizationQuery(api.analytics.dashboard.getStats);

const openRate = computed(() => stats.value?.openRate ?? 0);
const clickRate = computed(() => stats.value?.clickRate ?? 0);
const emailsSent = computed(() => stats.value?.emailsInLast30Days ?? 0);

function formatRate(rate: number): string {
	return `${new Intl.NumberFormat(locale.value).format(rate)}%`;
}

/**
 * Passed to UiNumberTicker, which formats every in-flight frame of the tween.
 * The ticker captures the formatter at setup, so the element is keyed on
 * `locale` in the template to re-render the current value on a language switch.
 */
function formatCount(value: number): string {
	return formatNumber(Math.round(value), locale.value);
}
</script>

<template>
	<UiCard class="h-full" padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiIconBox icon="lucide:bar-chart-3" size="sm" variant="surface" />
					<h3 class="text-sm font-semibold text-text-primary">
						{{ t('components.dashboard.cards.campaignPerformance.title') }}
					</h3>
				</div>
				<NuxtLink
					to="/dashboard/campaigns"
					class="text-xs font-medium whitespace-nowrap text-text-secondary hover:text-brand transition-colors"
				>
					{{ t('components.dashboard.cards.campaignPerformance.allCampaigns') }}
				</NuxtLink>
			</div>

			<DashboardCardSkeleton v-if="isLoading" shape="stat" hero :count="2" />

			<div v-else>
				<div class="flex items-baseline gap-2 mb-4">
					<span class="text-3xl font-bold tabular-nums text-text-primary">
						<UiNumberTicker :key="locale" :value="emailsSent" :formatter="formatCount" />
					</span>
					<span class="text-sm text-text-secondary">
						{{ t('components.dashboard.cards.campaignPerformance.emailsInThirtyDays') }}
					</span>
				</div>

				<div class="space-y-3">
					<div>
						<div class="flex items-center justify-between mb-1">
							<span class="text-xs text-text-secondary">{{
								t('components.dashboard.cards.campaignPerformance.openRate')
							}}</span>
							<span class="text-xs font-semibold tabular-nums text-text-primary">{{
								formatRate(openRate)
							}}</span>
						</div>
						<div class="h-1.5 bg-bg-surface rounded-full overflow-hidden">
							<div
								class="h-full bg-brand rounded-full transition-all duration-(--motion-slow)"
								:style="{ width: `${Math.min(openRate, 100)}%` }"
							/>
						</div>
					</div>
					<div>
						<div class="flex items-center justify-between mb-1">
							<span class="text-xs text-text-secondary">{{
								t('components.dashboard.cards.campaignPerformance.clickRate')
							}}</span>
							<span class="text-xs font-semibold tabular-nums text-text-primary">{{
								formatRate(clickRate)
							}}</span>
						</div>
						<div class="h-1.5 bg-bg-surface rounded-full overflow-hidden">
							<div
								class="h-full bg-success rounded-full transition-all duration-(--motion-slow)"
								:style="{ width: `${Math.min(clickRate, 100)}%` }"
							/>
						</div>
					</div>
				</div>
			</div>
		</div>
	</UiCard>
</template>
