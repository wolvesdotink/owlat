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

const { t, locale } = useI18n();

const chartHeight = 120;
const chartPadding = { top: 16, right: 12, bottom: 24, left: 48 };

const sortedData = computed(() => [...props.data].sort((a, b) => a.timestamp - b.timestamp));

const hasData = computed(() => sortedData.value.length >= 2);

const yBounds = computed(() => {
	if (!hasData.value) return { min: 0, max: 1 };
	const values = sortedData.value.map((d) => d.value);
	const min = Math.min(...values);
	const max = Math.max(...values);
	const padding = (max - min) * 0.1 || 1;
	return { min: Math.max(0, min - padding), max: max + padding };
});

// The viewBox follows the rendered width, so the drawing is never stretched:
// with a fixed 320-unit box and `preserveAspectRatio="none"` a wide card turned
// the points into ellipses and smeared the axis labels sideways.
const containerRef = ref<HTMLElement | null>(null);
const viewWidth = ref(320);
let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
	const el = containerRef.value;
	if (!el || typeof ResizeObserver === 'undefined') return;
	resizeObserver = new ResizeObserver((entries) => {
		const width = entries[0]?.contentRect.width ?? 0;
		if (width > 0) viewWidth.value = Math.round(width);
	});
	resizeObserver.observe(el);
});
onBeforeUnmount(() => resizeObserver?.disconnect());

const innerWidth = computed(() => viewWidth.value - chartPadding.left - chartPadding.right);
const innerHeight = chartHeight - chartPadding.top - chartPadding.bottom;

const points = computed(() => {
	const data = sortedData.value;
	if (data.length < 2) return [];
	const first = data[0];
	const last = data[data.length - 1];
	if (!first || !last) return [];
	const { min, max } = yBounds.value;
	const xMin = first.timestamp;
	const xMax = last.timestamp;
	const xRange = xMax - xMin || 1;
	const yRange = max - min || 1;

	return data.map((d) => ({
		x: chartPadding.left + ((d.timestamp - xMin) / xRange) * innerWidth.value,
		y: chartPadding.top + innerHeight - ((d.value - min) / yRange) * innerHeight,
		value: d.value,
		timestamp: d.timestamp,
	}));
});

const polylinePoints = computed(() => points.value.map((p) => `${p.x},${p.y}`).join(' '));

const areaPath = computed(() => {
	const pts = points.value;
	if (pts.length < 2) return '';
	const first = pts[0];
	const last = pts[pts.length - 1];
	if (!first || !last) return '';
	const baseline = chartPadding.top + innerHeight;
	let path = `M ${first.x},${baseline} L ${first.x},${first.y}`;
	for (let i = 1; i < pts.length; i++) {
		const p = pts[i];
		if (!p) continue;
		path += ` L ${p.x},${p.y}`;
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
	const data = sortedData.value;
	const first = data[0];
	const last = data[data.length - 1];
	if (!hasData.value || !first || !last) return { first: '', last: '' };
	return {
		first: formatTime(first.timestamp),
		last: formatTime(last.timestamp),
	};
});

function formatValue(v: number): string {
	if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
	if (v < 0.01 && v > 0) return v.toExponential(1);
	if (Number.isInteger(v)) return String(v);
	return v.toFixed(2);
}

// Data spanning more than a day gets its date too; a bare "09:00" at both ends
// of a multi-day range reads as the same moment.
const spansDays = computed(() => {
	const data = sortedData.value;
	const first = data[0];
	const last = data[data.length - 1];
	return !!first && !!last && last.timestamp - first.timestamp >= 24 * 60 * 60 * 1000;
});
function formatTime(ts: number): string {
	return new Intl.DateTimeFormat(locale.value, {
		...(spansDays.value ? { month: 'short', day: 'numeric' } : {}),
		hour: '2-digit',
		minute: '2-digit',
	}).format(new Date(ts));
}

// A one-line summary for screen readers: the range and the latest value.
const chartSummary = computed(() => {
	const data = sortedData.value;
	const last = data[data.length - 1];
	if (!hasData.value || !last) return props.label;
	return t('components.agent.metricChart.summary', {
		label: props.label,
		latest: formatValue(last.value),
		min: yLabels.value.min,
		max: yLabels.value.max,
		from: xLabels.value.first,
		to: xLabels.value.last,
	});
});
</script>

<template>
	<div ref="containerRef">
		<p class="text-sm font-medium text-text-secondary mb-2">{{ label }}</p>
		<div
			v-if="!hasData"
			class="flex items-center justify-center h-[120px] bg-bg-surface rounded-lg"
		>
			<p class="text-sm text-text-tertiary">{{ t('components.agent.metricChart.noData') }}</p>
		</div>
		<svg
			v-else
			:viewBox="`0 0 ${viewWidth} ${chartHeight}`"
			class="w-full"
			:style="{ height: `${chartHeight}px` }"
			preserveAspectRatio="none"
			role="img"
			:aria-label="chartSummary"
		>
			<!-- Grid lines -->
			<line
				:x1="chartPadding.left"
				:y1="chartPadding.top"
				:x2="chartPadding.left + innerWidth"
				:y2="chartPadding.top"
				stroke="currentColor"
				class="text-border-subtle"
				stroke-width="0.5"
				stroke-dasharray="4 2"
			/>
			<line
				:x1="chartPadding.left"
				:y1="chartPadding.top + innerHeight / 2"
				:x2="chartPadding.left + innerWidth"
				:y2="chartPadding.top + innerHeight / 2"
				stroke="currentColor"
				class="text-border-subtle"
				stroke-width="0.5"
				stroke-dasharray="4 2"
			/>
			<line
				:x1="chartPadding.left"
				:y1="chartPadding.top + innerHeight"
				:x2="chartPadding.left + innerWidth"
				:y2="chartPadding.top + innerHeight"
				stroke="currentColor"
				class="text-border-subtle"
				stroke-width="0.5"
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
				:x="chartPadding.left - 6"
				:y="chartPadding.top + 4"
				text-anchor="end"
				class="fill-text-tertiary"
				font-size="9"
			>
				{{ yLabels.max }}
			</text>
			<text
				:x="chartPadding.left - 6"
				:y="chartPadding.top + innerHeight / 2 + 3"
				text-anchor="end"
				class="fill-text-tertiary"
				font-size="9"
			>
				{{ yLabels.mid }}
			</text>
			<text
				:x="chartPadding.left - 6"
				:y="chartPadding.top + innerHeight + 4"
				text-anchor="end"
				class="fill-text-tertiary"
				font-size="9"
			>
				{{ yLabels.min }}
			</text>

			<!-- X-axis labels -->
			<text
				:x="chartPadding.left"
				:y="chartHeight - 4"
				text-anchor="start"
				class="fill-text-tertiary"
				font-size="9"
			>
				{{ xLabels.first }}
			</text>
			<text
				:x="chartPadding.left + innerWidth"
				:y="chartHeight - 4"
				text-anchor="end"
				class="fill-text-tertiary"
				font-size="9"
			>
				{{ xLabels.last }}
			</text>
		</svg>
	</div>
</template>
