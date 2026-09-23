<script setup lang="ts">
/**
 * The report's one comparison row: "vs Partner spotlight: open rate 38.4%
 * +4.9 pts · click rate 6.2% +2.8 pts". It replaces four count tiles and two
 * rate cards that repeated the funnel's numbers. Only rates carry a change,
 * in percentage points; counts are compared nowhere, because a points change
 * on a count means nothing and audiences differ in size.
 */
import {
	compareRates,
	type CampaignStatSnapshot,
	type RateComparison,
} from '~/utils/campaignReport';

const props = defineProps<{
	current: CampaignStatSnapshot;
	/** The previous comparable campaign, or null when there is none yet. */
	previous: (CampaignStatSnapshot & { name: string }) | null;
	isABTest: boolean;
	/** Scheduled or still sending: the numbers are live, not a result. */
	pending: boolean;
}>();

const { t } = useI18n();

const prefix = 'dashboard.campaigns.detail.report.comparison';

const rows = computed(() => compareRates(props.current, props.previous));

const lead = computed(() => {
	if (!props.previous) return null;
	return t(props.isABTest ? `${prefix}.versusAb` : `${prefix}.versus`, {
		name: props.previous.name,
	});
});

function rateLabel(row: RateComparison): string {
	return t(`${prefix}.${row.key}`);
}

function rateValue(row: RateComparison): string {
	return `${(row.rate * 100).toFixed(1)}%`;
}

function changeText(row: RateComparison): string | null {
	if (row.pointsChange === null) return null;
	if (row.pointsChange === 0) return t(`${prefix}.noChange`);
	const sign = row.pointsChange > 0 ? '+' : '−';
	return t(`${prefix}.points`, { change: `${sign}${Math.abs(row.pointsChange).toFixed(1)}` });
}

function changeTone(row: RateComparison): string {
	if (row.direction === 'up') return 'text-success';
	if (row.direction === 'down') return 'text-error';
	return 'text-text-tertiary';
}
</script>

<template>
	<div class="text-sm" data-testid="campaign-report-comparison">
		<p v-if="pending" class="text-text-tertiary">{{ t(`${prefix}.pendingCounts`) }}</p>
		<div v-else class="flex flex-wrap items-baseline gap-x-6 gap-y-2">
			<span v-if="lead" class="text-text-secondary" data-part="lead">{{ lead }}</span>
			<span
				v-for="row in rows"
				:key="row.key"
				class="inline-flex items-baseline gap-2"
				:data-rate="row.key"
			>
				<span class="text-text-secondary">{{ rateLabel(row) }}</span>
				<span class="font-medium text-text-primary tabular-nums">{{ rateValue(row) }}</span>
				<span v-if="changeText(row)" :class="['tabular-nums', changeTone(row)]">{{
					changeText(row)
				}}</span>
			</span>
			<span v-if="!previous" class="text-text-tertiary" data-part="no-comparable">{{
				t(`${prefix}.noComparable`)
			}}</span>
		</div>
	</div>
</template>
