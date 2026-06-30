<script setup lang="ts">
interface DataPoint {
	timestamp: number;
	value: number;
}

interface Props {
	data: DataPoint[];
	label: string;
	color?: string;
}

const props = withDefaults(defineProps<Props>(), {
	color: 'var(--color-brand)',
});

const chartHeight = 120;
const chartPadding = { top: 16, right: 12, bottom: 24, left: 48 };

const sortedData = computed(() =>
	[...props.data].sort((a, b) => a.timestamp - b.timestamp)
);

const hasData = computed(() => sortedData.value.length >= 2);

const yBounds = computed(() => {
	if (!hasData.value) return { min: 0, max: 1 };
	const values = sortedData.value.map((d) => d.value);
	const min = Math.min(...values);
	const max = Math.max(...values);
	const padding = (max - min) * 0.1 || 1;
	return { min: Math.max(0, min - padding), max: max + padding };
});

const viewWidth = 320;
const innerWidth = viewWidth - chartPadding.left - chartPadding.right;
const innerHeight = chartHeight - chartPadding.top - chartPadding.bottom;

const points = computed(() => {
	if (!hasData.value) return [];
	const { min, max } = yBounds.value;
	const xMin = sortedData.value[0]!.timestamp;
	const xMax = sortedData.value[sortedData.value.length - 1]!.timestamp;
	const xRange = xMax - xMin || 1;
	const yRange = max - min || 1;

	return sortedData.value.map((d) => ({
		x: chartPadding.left + ((d.timestamp - xMin) / xRange) * innerWidth,
		y: chartPadding.top + innerHeight - ((d.value - min) / yRange) * innerHeight,
		value: d.value,
		timestamp: d.timestamp,
	}));
});

const polylinePoints = computed(() =>
	points.value.map((p) => `${p.x},${p.y}`).join(' ')
);

const areaPath = computed(() => {
	if (points.value.length < 2) return '';
	const first = points.value[0]!;
	const last = points.value[points.value.length - 1]!;
	const baseline = chartPadding.top + innerHeight;
	let path = `M ${first.x},${baseline} L ${first.x},${first.y}`;
	for (let i = 1; i < points.value.length; i++) {
		path += ` L ${points.value[i]!.x},${points.value[i]!.y}`;
	}
	path += ` L ${last.x},${baseline} Z`;
	return path;
});

const yLabels = computed(() => {
	const { min, max } = yBounds.value;
	return {
		max: formatValue(max),
		mid: formatValue((max + min) / 2),
		min: formatValue(min),
	};
});

const xLabels = computed(() => {
	if (!hasData.value) return { first: '', last: '' };
	return {
		first: formatTime(sortedData.value[0]!.timestamp),
		last: formatTime(sortedData.value[sortedData.value.length - 1]!.timestamp),
	};
});

function formatValue(v: number): string {
	if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
	if (v < 0.01 && v > 0) return v.toExponential(1);
	if (Number.isInteger(v)) return String(v);
	return v.toFixed(2);
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}
</script>

<template>
	<div>
		<p class="text-sm font-medium text-text-secondary mb-2">{{ label }}</p>
		<div v-if="!hasData" class="flex items-center justify-center h-[120px] bg-bg-surface rounded-lg">
			<p class="text-sm text-text-tertiary">No data available</p>
		</div>
		<svg
			v-else
			:viewBox="`0 0 ${viewWidth} ${chartHeight}`"
			class="w-full"
			:style="{ height: `${chartHeight}px` }"
			preserveAspectRatio="none"
		>
			<!-- Grid lines -->
			<line
				:x1="chartPadding.left" :y1="chartPadding.top"
				:x2="chartPadding.left + innerWidth" :y2="chartPadding.top"
				stroke="currentColor" class="text-border-subtle" stroke-width="0.5" stroke-dasharray="4 2"
			/>
			<line
				:x1="chartPadding.left" :y1="chartPadding.top + innerHeight / 2"
				:x2="chartPadding.left + innerWidth" :y2="chartPadding.top + innerHeight / 2"
				stroke="currentColor" class="text-border-subtle" stroke-width="0.5" stroke-dasharray="4 2"
			/>
			<line
				:x1="chartPadding.left" :y1="chartPadding.top + innerHeight"
				:x2="chartPadding.left + innerWidth" :y2="chartPadding.top + innerHeight"
				stroke="currentColor" class="text-border-subtle" stroke-width="0.5"
			/>

			<!-- Area fill -->
			<path :d="areaPath" :fill="color" opacity="0.1" />

			<!-- Line -->
			<polyline
				:points="polylinePoints"
				fill="none"
				:stroke="color"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>

			<!-- Data points -->
			<circle
				v-for="(point, i) in points"
				:key="i"
				:cx="point.x"
				:cy="point.y"
				r="3"
				:fill="color"
				stroke="var(--color-bg-elevated, white)"
				stroke-width="1.5"
			/>

			<!-- Y-axis labels -->
			<text
				:x="chartPadding.left - 6" :y="chartPadding.top + 4"
				text-anchor="end" class="fill-text-tertiary" font-size="9"
			>{{ yLabels.max }}</text>
			<text
				:x="chartPadding.left - 6" :y="chartPadding.top + innerHeight / 2 + 3"
				text-anchor="end" class="fill-text-tertiary" font-size="9"
			>{{ yLabels.mid }}</text>
			<text
				:x="chartPadding.left - 6" :y="chartPadding.top + innerHeight + 4"
				text-anchor="end" class="fill-text-tertiary" font-size="9"
			>{{ yLabels.min }}</text>

			<!-- X-axis labels -->
			<text
				:x="chartPadding.left" :y="chartHeight - 4"
				text-anchor="start" class="fill-text-tertiary" font-size="9"
			>{{ xLabels.first }}</text>
			<text
				:x="chartPadding.left + innerWidth" :y="chartHeight - 4"
				text-anchor="end" class="fill-text-tertiary" font-size="9"
			>{{ xLabels.last }}</text>
		</svg>
	</div>
</template>
