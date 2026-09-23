<script setup lang="ts">
/**
 * Band 2's headline row: five totals for every campaign sent in the last 30
 * days, each against the 30 days before and with a 12-week sparkline. Rates
 * compare in percentage points; delivered compares as a relative change.
 * Unsubscribe and bounce rates are lower-is-better, so their delta colour is
 * inverted while the arrow keeps pointing the way the number moved.
 */
import type { MarketingPeriod } from '~/utils/marketingOverviewTypes';
import { pointsDelta } from '~/utils/marketingHeadline';
import { formatNumber, formatPercentage } from '~/utils/formatters';

const props = defineProps<{ period: MarketingPeriod }>();

const { t } = useI18n();

type TileKey = 'delivered' | 'openRate' | 'clickRate' | 'unsubscribeRate' | 'bounceRate';

const TILES: { key: TileKey; lowerIsBetter: boolean }[] = [
	{ key: 'delivered', lowerIsBetter: false },
	{ key: 'openRate', lowerIsBetter: false },
	{ key: 'clickRate', lowerIsBetter: false },
	{ key: 'unsubscribeRate', lowerIsBetter: true },
	{ key: 'bounceRate', lowerIsBetter: true },
];

type Direction = 'up' | 'down' | 'flat';
type Tone = 'positive' | 'negative' | 'neutral';

function deltaFor(key: TileKey, lowerIsBetter: boolean) {
	const current = props.period.current[key];
	const previous = props.period.previous[key];
	// Nothing sent in the previous window: there is no comparison to make.
	if (props.period.previous.delivered === 0) return { text: null, direction: 'flat' as Direction };
	let sign: -1 | 0 | 1;
	let text: string;
	if (key === 'delivered') {
		const change = (current - previous) / previous;
		sign = Math.round(change * 100) === 0 ? 0 : change > 0 ? 1 : -1;
		text = t('components.marketing.period.percentChange', {
			percent: formatPercentage(Math.abs(change), 0),
		});
	} else {
		const delta = pointsDelta(current, previous);
		sign = delta.sign;
		text = t('components.marketing.period.pointsChange', {
			points: delta.text.replace(/^[+−]/, ''),
		});
	}
	const direction: Direction = sign > 0 ? 'up' : sign < 0 ? 'down' : 'flat';
	const good = lowerIsBetter ? -sign : sign;
	const tone: Tone = good > 0 ? 'positive' : good < 0 ? 'negative' : 'neutral';
	return { text, direction, tone };
}

const tiles = computed(() =>
	TILES.map(({ key, lowerIsBetter }) => {
		const value = props.period.current[key];
		const label = t(`components.marketing.period.tiles.${key}`);
		return {
			key,
			label,
			value: key === 'delivered' ? formatNumber(value) : formatPercentage(value, 1),
			spark: props.period.weekly.map((w) => w[key]),
			sparkLabel: t('components.marketing.period.sparkLabel', { metric: label }),
			...deltaFor(key, lowerIsBetter),
		};
	})
);
</script>

<template>
	<div>
		<div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4 sm:gap-6">
			<div v-for="tile in tiles" :key="tile.key" class="flex flex-col gap-2">
				<UiStatTile
					:label="tile.label"
					:value="tile.value"
					:delta="tile.text"
					:delta-direction="tile.direction"
					:delta-tone="tile.tone"
				/>
				<UiSparkline :data="tile.spark" :ariaLabel="tile.sparkLabel" />
			</div>
		</div>
		<p class="mt-4 text-xs text-text-tertiary">
			{{ t('components.marketing.period.comparisonNote') }}
		</p>
	</div>
</template>
