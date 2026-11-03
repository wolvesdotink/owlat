<script setup lang="ts">
// The campaign report's "Opens over time" card: the first 48 hours after the
// first recorded open.
import { formatNumber } from '~/utils/formatters';
import { EyeIcon } from '@coolicons/vue';

const props = defineProps<{
	opensTimeline: ReadonlyArray<{ timestamp: number; count: number }> | null | undefined;
}>();

const { t } = useI18n();

// Opens timeline → first-48h curve for UiTrendChart. Labels are hours since
// the first recorded open; the peak is direct-labeled by the chart.
const timelineData = computed<{ label: string; value: number }[]>(() => {
	const raw = props.opensTimeline;
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
</script>

<template>
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
			<EyeIcon class="w-10 h-10 text-text-tertiary mb-3" :stroke-width="1.5" />
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
</template>
