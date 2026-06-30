<script setup lang="ts">
import { api } from '@owlat/api';

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
	<UiCard padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiIconBox icon="lucide:trending-up" size="sm" variant="brand" />
					<h3 class="text-sm font-semibold text-text-primary">Accuracy Trend</h3>
				</div>
				<NuxtLink
					to="/dashboard/settings/agent-health"
					class="text-xs font-medium text-brand hover:text-brand/80 transition-colors"
				>
					Details
				</NuxtLink>
			</div>

			<div v-if="isLoading" class="flex items-center justify-center py-6">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" aria-label="Loading" />
			</div>

			<div v-else-if="series.length === 0" class="py-4 text-center">
				<p class="text-sm text-text-tertiary">No accuracy data recorded yet</p>
			</div>

			<div v-else>
				<dl v-if="latest" class="grid grid-cols-2 gap-2 mb-4">
					<div class="rounded-lg bg-bg-surface px-3 py-2">
						<dt class="text-xs text-text-tertiary">Auto-approve</dt>
						<dd class="text-lg font-semibold text-success">{{ formatPct(latest.autoApproveRatio) }}</dd>
					</div>
					<div class="rounded-lg bg-bg-surface px-3 py-2">
						<dt class="text-xs text-text-tertiary">Rejection</dt>
						<dd class="text-lg font-semibold text-error">{{ formatPct(latest.rejectionRate) }}</dd>
					</div>
				</dl>

				<div class="space-y-3">
					<AgentMetricChart
						:data="autoApproveData"
						label="Auto-approve ratio"
						color="var(--color-success)"
					/>
					<AgentMetricChart
						:data="rejectionData"
						label="Rejection rate"
						color="var(--color-error)"
					/>
				</div>
			</div>
		</div>
	</UiCard>
</template>
