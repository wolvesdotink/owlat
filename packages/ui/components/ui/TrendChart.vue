<script setup lang="ts">
/**
 * UiTrendChart — line/area time-series on the FF chart rules: single hue
 * (brand by default), one axis, recessive dashed grid, tabular numerals,
 * crosshair hover with a tooltip. Hand-rolled SVG — no chart library.
 */
import {
	buildAreaPath,
	buildLinePoints,
	computeChartPoints,
	computeYBounds,
	formatChartValue,
	nearestPointIndex,
	type ChartDatum,
} from '../../utils/chart';

interface Props {
	data: ChartDatum[];
	color?: string;
	showArea?: boolean;
	formatValue?: (value: number) => string;
	ariaLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
	color: 'var(--color-brand)',
	showArea: true,
	formatValue: formatChartValue,
	ariaLabel: 'Trend chart',
});

const viewWidth = 320;
const viewHeight = 120;
const padding = { top: 16, right: 12, bottom: 24, left: 48 };
const innerWidth = viewWidth - padding.left - padding.right;
const innerHeight = viewHeight - padding.top - padding.bottom;
const baselineY = padding.top + innerHeight;

const hasData = computed(() => props.data.length >= 2);

const points = computed(() =>
	computeChartPoints(props.data, { width: viewWidth, height: viewHeight, padding })
);

const linePoints = computed(() => buildLinePoints(points.value));
const areaPath = computed(() => buildAreaPath(points.value, baselineY));
const endpoint = computed(() => points.value[points.value.length - 1]);

const yLabels = computed(() => {
	const { min, max } = computeYBounds(props.data.map((d) => d.value));
	return {
		max: props.formatValue(max),
		mid: props.formatValue((max + min) / 2),
		min: props.formatValue(min),
	};
});

const xLabels = computed(() => {
	if (!hasData.value) return { first: '', last: '' };
	return {
		first: props.data[0]!.label,
		last: props.data[props.data.length - 1]!.label,
	};
});

// Crosshair hover — pointer events land on an invisible overlay rect; the
// nearest data point drives the crosshair, dot and tooltip.
const hoverIndex = ref<number | null>(null);
const hoverPoint = computed(() =>
	hoverIndex.value === null ? null : (points.value[hoverIndex.value] ?? null)
);

function onPointerMove(event: PointerEvent) {
	const target = event.currentTarget as SVGRectElement;
	const rect = target.getBoundingClientRect();
	if (rect.width === 0) return;
	const x = padding.left + ((event.clientX - rect.left) / rect.width) * innerWidth;
	hoverIndex.value = nearestPointIndex(points.value, x);
}

function onPointerLeave() {
	hoverIndex.value = null;
}
</script>

<template>
	<div>
		<div
			v-if="!hasData"
			class="flex items-center justify-center h-[120px] bg-bg-surface rounded-lg"
		>
			<p class="text-sm text-text-tertiary">No data yet</p>
		</div>
		<div v-else class="relative">
			<svg
				:viewBox="`0 0 ${viewWidth} ${viewHeight}`"
				class="w-full"
				:style="{ height: `${viewHeight}px` }"
				preserveAspectRatio="none"
				role="img"
				:aria-label="ariaLabel"
			>
				<!-- Recessive dashed grid + solid baseline -->
				<line
					:x1="padding.left"
					:y1="padding.top"
					:x2="padding.left + innerWidth"
					:y2="padding.top"
					stroke="var(--chart-grid)"
					stroke-width="0.5"
					stroke-dasharray="4 2"
				/>
				<line
					:x1="padding.left"
					:y1="padding.top + innerHeight / 2"
					:x2="padding.left + innerWidth"
					:y2="padding.top + innerHeight / 2"
					stroke="var(--chart-grid)"
					stroke-width="0.5"
					stroke-dasharray="4 2"
				/>
				<line
					:x1="padding.left"
					:y1="baselineY"
					:x2="padding.left + innerWidth"
					:y2="baselineY"
					stroke="var(--chart-grid)"
					stroke-width="0.5"
				/>

				<!-- Area fill -->
				<path v-if="showArea" :d="areaPath" :fill="color" opacity="0.1" />

				<!-- Line -->
				<polyline
					:points="linePoints"
					fill="none"
					:stroke="color"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>

				<!-- Crosshair (hover) -->
				<g v-if="hoverPoint">
					<line
						:x1="hoverPoint.x"
						:y1="padding.top"
						:x2="hoverPoint.x"
						:y2="baselineY"
						stroke="var(--chart-grid)"
						stroke-width="1"
					/>
					<circle
						:cx="hoverPoint.x"
						:cy="hoverPoint.y"
						r="3.5"
						:fill="color"
						stroke="var(--color-bg-elevated)"
						stroke-width="1.5"
					/>
				</g>

				<!-- Endpoint dot -->
				<circle
					v-if="endpoint && !hoverPoint"
					:cx="endpoint.x"
					:cy="endpoint.y"
					r="3.5"
					:fill="color"
					stroke="var(--color-bg-elevated)"
					stroke-width="1.5"
				/>

				<!-- Y-axis labels (max/mid/min) -->
				<text
					:x="padding.left - 6"
					:y="padding.top + 4"
					text-anchor="end"
					class="fill-text-tertiary tabular-nums"
					font-size="9"
				>
					{{ yLabels.max }}
				</text>
				<text
					:x="padding.left - 6"
					:y="padding.top + innerHeight / 2 + 3"
					text-anchor="end"
					class="fill-text-tertiary tabular-nums"
					font-size="9"
				>
					{{ yLabels.mid }}
				</text>
				<text
					:x="padding.left - 6"
					:y="baselineY + 4"
					text-anchor="end"
					class="fill-text-tertiary tabular-nums"
					font-size="9"
				>
					{{ yLabels.min }}
				</text>

				<!-- X-axis labels (first/last) -->
				<text
					:x="padding.left"
					:y="viewHeight - 4"
					text-anchor="start"
					class="fill-text-tertiary tabular-nums"
					font-size="9"
				>
					{{ xLabels.first }}
				</text>
				<text
					:x="padding.left + innerWidth"
					:y="viewHeight - 4"
					text-anchor="end"
					class="fill-text-tertiary tabular-nums"
					font-size="9"
				>
					{{ xLabels.last }}
				</text>

				<!-- Invisible pointer-capture overlay (kept last so it is on top) -->
				<rect
					:x="padding.left"
					:y="padding.top"
					:width="innerWidth"
					:height="innerHeight"
					fill="transparent"
					@pointermove="onPointerMove"
					@pointerleave="onPointerLeave"
				/>
			</svg>

			<!-- Tooltip — opacity-only reveal, never intercepts the pointer -->
			<div
				class="absolute top-0 -translate-x-1/2 -translate-y-1 pointer-events-none rounded-md bg-bg-overlay shadow-surface-4 px-2 py-1 whitespace-nowrap transition-opacity duration-(--motion-fast)"
				:class="hoverPoint ? 'opacity-100' : 'opacity-0'"
				:style="{ left: `${((hoverPoint?.x ?? 0) / viewWidth) * 100}%` }"
				aria-hidden="true"
			>
				<p class="text-[10px] text-text-tertiary leading-tight">{{ hoverPoint?.label }}</p>
				<p class="text-xs font-semibold text-text-primary tabular-nums leading-tight">
					{{ hoverPoint ? formatValue(hoverPoint.value) : '' }}
				</p>
			</div>
		</div>
	</div>
</template>
