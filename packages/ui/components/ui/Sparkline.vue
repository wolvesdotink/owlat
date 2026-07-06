<script setup lang="ts">
/**
 * UiSparkline — inline mini trend (no axes, no grid) for list rows and stat
 * tiles. Purely presentational; the required aria-label carries the meaning.
 */
import { buildLinePoints, computeChartPoints, type ChartDatum } from '../../utils/chart';

interface Props {
	data: number[];
	ariaLabel: string;
	color?: string;
	width?: number;
	height?: number;
}

const props = withDefaults(defineProps<Props>(), {
	color: 'var(--color-brand)',
	width: 88,
	height: 26,
});

const pad = 3;

const hasData = computed(() => props.data.length >= 2);

const points = computed(() =>
	computeChartPoints(
		props.data.map((value, i) => ({ label: String(i), value }) as ChartDatum),
		{
			width: props.width,
			height: props.height,
			padding: { top: pad, right: pad, bottom: pad, left: pad },
		}
	)
);

const linePoints = computed(() => buildLinePoints(points.value));
const endpoint = computed(() => points.value[points.value.length - 1]);
</script>

<template>
	<svg
		v-if="hasData"
		:viewBox="`0 0 ${width} ${height}`"
		:width="width"
		:height="height"
		class="inline-block align-middle"
		role="img"
		:aria-label="ariaLabel"
	>
		<polyline
			:points="linePoints"
			fill="none"
			:stroke="color"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
		<circle
			v-if="endpoint"
			:cx="endpoint.x"
			:cy="endpoint.y"
			r="2"
			:fill="color"
			stroke="var(--color-bg-elevated)"
			stroke-width="1"
		/>
	</svg>
	<span v-else class="text-[10px] text-text-tertiary" :aria-label="ariaLabel">&mdash;</span>
</template>
