<script setup lang="ts">
/**
 * The report funnel: Sent → Delivered → Opened → Clicked, then the two leaks
 * (Unsubscribed, Bounced). Each step shows its count and its rate against a
 * NAMED base — "of sent", "of delivered", "of opened" — never an anonymous
 * "of previous", which a few pixels away could be read as "the previous
 * campaign". The bar length is the share of everything sent, in one hue.
 * Hovering a step shows the exact numbers behind the percentage.
 */
import { formatNumber, formatPercentage } from '~/utils/formatters';

const props = withDefaults(
	defineProps<{
		sent: number;
		delivered: number;
		opened: number;
		clicked: number;
		unsubscribed: number;
		/** Omitted → no bounced row (e.g. before the counters have loaded). */
		bounced?: number | null;
	}>(),
	{ bounced: null }
);

const { t } = useI18n();

type StepKey = 'sent' | 'delivered' | 'opened' | 'clicked' | 'unsubscribed' | 'bounced';

/**
 * Each step's rate base. Unsubscribes and bounces are measured against the
 * mail that could produce them (delivered and sent), not the row above them —
 * "unsubscribed of clicked" would be a meaningless number.
 */
const BASE: Record<StepKey, StepKey | null> = {
	sent: null,
	delivered: 'sent',
	opened: 'delivered',
	clicked: 'opened',
	unsubscribed: 'delivered',
	bounced: 'sent',
};

const steps = computed(() => {
	const counts: Record<StepKey, number | null> = {
		sent: props.sent,
		delivered: props.delivered,
		opened: props.opened,
		clicked: props.clicked,
		unsubscribed: props.unsubscribed,
		bounced: props.bounced,
	};
	const order: StepKey[] = ['sent', 'delivered', 'opened', 'clicked', 'unsubscribed', 'bounced'];
	return order.flatMap((key) => {
		const count = counts[key];
		if (count === null) return [];
		const baseKey = BASE[key];
		const base = baseKey ? counts[baseKey] : null;
		const ofBase = base !== null && base > 0 ? count / base : null;
		const label = t(`components.campaigns.funnel.steps.${key}`);
		return [
			{
				key,
				label,
				count: formatNumber(count),
				share: props.sent > 0 ? Math.min(1, count / props.sent) : 0,
				rate:
					ofBase === null || baseKey === null
						? null
						: t(`components.campaigns.funnel.rates.${key}`, {
								percent: formatPercentage(ofBase, 1),
							}),
				title:
					baseKey && base !== null
						? t('components.campaigns.funnel.stepTitle', {
								count: formatNumber(count),
								step: label,
								previous: formatNumber(base),
								previousStep: t(`components.campaigns.funnel.steps.${baseKey}`),
							})
						: `${label}: ${formatNumber(count)}`,
			},
		];
	});
});
</script>

<template>
	<!-- One grid shared by every row (subgrid), so the bars, counts and rates
	     line up in columns instead of each row sizing its own. -->
	<ol
		class="grid grid-cols-[minmax(0,5rem)_1fr_auto_auto] sm:grid-cols-[7rem_1fr_auto_auto] gap-x-3 gap-y-2.5"
		:aria-label="t('components.campaigns.funnel.ariaLabel')"
	>
		<li
			v-for="step in steps"
			:key="step.key"
			class="col-span-4 grid grid-cols-subgrid items-center text-sm"
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
			<span class="tabular-nums text-right font-medium text-text-primary">{{ step.count }}</span>
			<span class="tabular-nums text-right whitespace-nowrap text-xs text-text-tertiary">{{
				step.rate ?? ''
			}}</span>
		</li>
	</ol>
</template>
