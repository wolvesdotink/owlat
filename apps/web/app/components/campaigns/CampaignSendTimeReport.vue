<script setup lang="ts">
/**
 * The report's send-time optimization card: how the contacts sent at their
 * own best hour engaged next to the comparison group sent at the start time.
 * The verdict comes from `compareSendTimeArms`, which only calls a difference
 * that is beyond chance.
 */
import { compareSendTimeArms, MIN_DELIVERED_PER_GROUP } from '~/utils/sendTimeComparison';
import type { SendTimeMetricComparison } from '~/utils/sendTimeComparison';

const props = defineProps<{
	campaign: {
		status: string;
		sendTimeOptimization?: { windowHours: number; holdoutPercent: number };
		statsSendTimeOptimizedDelivered?: number;
		statsSendTimeOptimizedOpened?: number;
		statsSendTimeOptimizedClicked?: number;
		statsSendTimeHoldoutDelivered?: number;
		statsSendTimeHoldoutOpened?: number;
		statsSendTimeHoldoutClicked?: number;
	};
}>();

const { t, locale } = useI18n();
const prefix = 'components.campaigns.sendTimeReport';

const comparison = computed(() => compareSendTimeArms(props.campaign));
const settings = computed(() => props.campaign.sendTimeOptimization);

const numberFormat = computed(() => new Intl.NumberFormat(locale.value));
const formatRate = (value: number) => `${(value * 100).toFixed(1)}%`;

function changeText(metric: SendTimeMetricComparison): string {
	const sign = metric.pointsChange > 0 ? '+' : metric.pointsChange < 0 ? '−' : '±';
	return t(`${prefix}.points`, { change: `${sign}${Math.abs(metric.pointsChange).toFixed(1)}` });
}

function verdictTone(metric: SendTimeMetricComparison): string {
	if (metric.verdict === 'higher') return 'text-success';
	if (metric.verdict === 'lower') return 'text-error';
	return 'text-text-tertiary';
}
</script>

<template>
	<div class="card p-4 sm:p-6" data-testid="campaign-send-time-report">
		<div class="flex items-start gap-3">
			<UiIconBox icon="lucide:sparkles" size="sm" rounded="lg" />
			<div class="min-w-0">
				<h3 class="text-base font-medium text-text-primary">{{ t(`${prefix}.title`) }}</h3>
				<p v-if="settings" class="text-sm text-text-secondary mt-1">
					{{
						settings.holdoutPercent > 0
							? t(`${prefix}.summaryWithHoldout`, {
									hours: settings.windowHours,
									percent: settings.holdoutPercent,
								})
							: t(`${prefix}.summary`, { hours: settings.windowHours })
					}}
				</p>
			</div>
		</div>

		<p
			v-if="comparison.state === 'no_holdout'"
			class="mt-4 text-sm text-text-secondary"
			data-state="no-holdout"
		>
			{{ t(`${prefix}.noHoldout`) }}
		</p>

		<p
			v-else-if="comparison.state === 'too_early'"
			class="mt-4 text-sm text-text-secondary"
			data-state="too-early"
		>
			{{
				t(`${prefix}.tooEarly`, {
					min: numberFormat.format(MIN_DELIVERED_PER_GROUP),
					optimized: numberFormat.format(comparison.optimized.delivered),
					holdout: numberFormat.format(comparison.holdout.delivered),
				})
			}}
		</p>

		<div v-else class="mt-4 overflow-x-auto" data-state="ready">
			<table class="w-full text-sm">
				<thead>
					<tr class="text-left text-xs text-text-tertiary">
						<th class="py-2 pr-4 font-normal">{{ t(`${prefix}.metric`) }}</th>
						<th class="py-2 pr-4 font-normal text-right">
							{{
								t(`${prefix}.optimizedColumn`, {
									count: numberFormat.format(comparison.optimized.delivered),
								})
							}}
						</th>
						<th class="py-2 pr-4 font-normal text-right">
							{{
								t(`${prefix}.holdoutColumn`, {
									count: numberFormat.format(comparison.holdout.delivered),
								})
							}}
						</th>
						<th class="py-2 font-normal text-right">{{ t(`${prefix}.difference`) }}</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="metric in comparison.metrics"
						:key="metric.key"
						class="border-t border-border-subtle"
						:data-metric="metric.key"
					>
						<td class="py-2 pr-4 text-text-secondary">{{ t(`${prefix}.${metric.key}`) }}</td>
						<td class="py-2 pr-4 text-right font-medium text-text-primary tabular-nums">
							{{ formatRate(metric.optimizedRate) }}
						</td>
						<td class="py-2 pr-4 text-right text-text-primary tabular-nums">
							{{ formatRate(metric.holdoutRate) }}
						</td>
						<td class="py-2 text-right tabular-nums">
							<span :class="verdictTone(metric)">{{ changeText(metric) }}</span>
							<span class="block text-xs text-text-tertiary">
								{{ t(`${prefix}.verdict.${metric.verdict}`) }}
							</span>
						</td>
					</tr>
				</tbody>
			</table>
			<p class="mt-3 text-xs text-text-tertiary">{{ t(`${prefix}.method`) }}</p>
		</div>

		<p v-if="campaign.status === 'sending'" class="mt-3 text-xs text-text-tertiary">
			{{ t(`${prefix}.stillSending`) }}
		</p>
	</div>
</template>
