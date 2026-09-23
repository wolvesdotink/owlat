<script setup lang="ts">
/**
 * The report funnel: Sent → Delivered → Opened → Clicked → Unsubscribed. Each
 * step shows its count and the share of the step before it; the bar length is
 * the share of everything sent, in one hue. Hovering a step shows the exact
 * numbers behind the percentage.
 */
import { formatNumber, formatPercentage } from '~/utils/formatters';

const props = defineProps<{
	sent: number;
	delivered: number;
	opened: number;
	clicked: number;
	unsubscribed: number;
}>();

const { t } = useI18n();

type StepKey = 'sent' | 'delivered' | 'opened' | 'clicked' | 'unsubscribed';
const ORDER: StepKey[] = ['sent', 'delivered', 'opened', 'clicked', 'unsubscribed'];

const steps = computed(() =>
	ORDER.map((key, index) => {
		const count = props[key];
		const previousKey = index > 0 ? ORDER[index - 1]! : null;
		const previous = previousKey ? props[previousKey] : null;
		const ofPrevious = previous !== null && previous > 0 ? count / previous : null;
		const label = t(`components.campaigns.funnel.steps.${key}`);
		return {
			key,
			label,
			count: formatNumber(count),
			share: props.sent > 0 ? Math.min(1, count / props.sent) : 0,
			ofPrevious: ofPrevious === null ? null : formatPercentage(ofPrevious, 1),
			title:
				previousKey && previous !== null
					? t('components.campaigns.funnel.stepTitle', {
							count: formatNumber(count),
							step: label,
							previous: formatNumber(previous),
							previousStep: t(`components.campaigns.funnel.steps.${previousKey}`),
						})
					: `${label}: ${formatNumber(count)}`,
		};
	})
);
</script>

<template>
	<ol class="flex flex-col gap-2.5" :aria-label="t('components.campaigns.funnel.ariaLabel')">
		<li
			v-for="step in steps"
			:key="step.key"
			class="grid grid-cols-[7rem_1fr_auto] items-center gap-3 text-sm"
			:title="step.title"
			:data-step="step.key"
		>
			<span class="text-text-secondary truncate">{{ step.label }}</span>
			<div class="h-2 bg-bg-surface rounded-full overflow-hidden" aria-hidden="true">
				<div
					class="h-full bg-brand rounded-full"
					:style="{ width: step.share > 0 ? `${Math.max(step.share * 100, 1)}%` : '0%' }"
				/>
			</div>
			<span class="tabular-nums text-right whitespace-nowrap">
				<span class="font-medium text-text-primary">{{ step.count }}</span>
				<span v-if="step.ofPrevious" class="ml-2 text-xs text-text-tertiary">
					{{ t('components.campaigns.funnel.ofPrevious', { percent: step.ofPrevious }) }}
				</span>
			</span>
		</li>
	</ol>
</template>
