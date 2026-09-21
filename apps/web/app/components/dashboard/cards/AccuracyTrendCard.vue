<script setup lang="ts">
import { api } from '@owlat/api';

const { t } = useI18n();

const { data: trend, isLoading } = useOrganizationQuery(api.agentHealth.getAccuracyTrend);

interface TrendPoint {
	windowStart: number;
	autoApproveRatio: number;
	rejectionRate: number;
}

const series = computed<TrendPoint[]>(() => trend.value?.series ?? []);

const autoApproveData = computed(() =>
	series.value.map((p) => ({ timestamp: p.windowStart, value: p.autoApproveRatio }))
);
const rejectionData = computed(() =>
	series.value.map((p) => ({ timestamp: p.windowStart, value: p.rejectionRate }))
);

const latest = computed(() => series.value[series.value.length - 1] ?? null);

function formatPct(ratio: number): string {
	return `${Math.round(ratio * 100)}%`;
}
</script>

<template>
	<UiCard class="h-full" padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiIconBox icon="lucide:trending-up" size="sm" variant="surface" />
					<h3 class="text-sm font-semibold text-text-primary">
						{{ t('components.dashboard.cards.accuracyTrend.title') }}
					</h3>
				</div>
				<NuxtLink
					to="/dashboard/admin/instance/agent-health"
					class="text-xs font-medium whitespace-nowrap text-text-secondary hover:text-brand transition-colors"
				>
					{{ t('components.dashboard.cards.accuracyTrend.details') }}
				</NuxtLink>
			</div>

			<!-- Two regions to stand in for: the tile pair, then the two plots. -->
			<template v-if="isLoading">
				<DashboardCardSkeleton
					shape="metrics"
					:count="2"
					class="mb-4"
					:label="t('components.dashboard.cards.accuracyTrend.loading')"
				/>
				<DashboardCardSkeleton shape="chart" :count="2" />
			</template>

			<div v-else-if="series.length === 0" class="py-4 text-center">
				<p class="text-sm text-text-tertiary">
					{{ t('components.dashboard.cards.accuracyTrend.empty') }}
				</p>
			</div>

			<div v-else>
				<dl v-if="latest" class="grid grid-cols-2 gap-2 mb-4">
					<div class="rounded-lg bg-bg-surface px-3 py-2">
						<dt class="text-xs text-text-tertiary">
							{{ t('components.dashboard.cards.accuracyTrend.autoApprove') }}
						</dt>
						<dd class="text-lg font-semibold tabular-nums text-success">
							{{ formatPct(latest.autoApproveRatio) }}
						</dd>
					</div>
					<div class="rounded-lg bg-bg-surface px-3 py-2">
						<dt class="text-xs text-text-tertiary">
							{{ t('components.dashboard.cards.accuracyTrend.rejection') }}
						</dt>
						<dd class="text-lg font-semibold tabular-nums text-error">
							{{ formatPct(latest.rejectionRate) }}
						</dd>
					</div>
				</dl>

				<div class="space-y-3">
					<AgentMetricChart
						:data="autoApproveData"
						:label="t('components.dashboard.cards.accuracyTrend.autoApproveRatio')"
						color="var(--color-success)"
					/>
					<AgentMetricChart
						:data="rejectionData"
						:label="t('components.dashboard.cards.accuracyTrend.rejectionRate')"
						color="var(--color-error)"
					/>
				</div>
			</div>
		</div>
	</UiCard>
</template>
