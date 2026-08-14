<script setup lang="ts">
/**
 * DAILY SENDING, STACKED BY ARM — own server below, relay above.
 *
 * Inline SVG in the shape the repo already uses for trends (`agent/MetricChart`):
 * no chart library, no external request, geometry computed here and nothing else.
 *
 * ACCESSIBLE, NOT MERELY COLOURED. The two bands differ in fill AND in hatching,
 * so the split survives a greyscale print and a colour-vision deficiency; the
 * whole figure carries a text summary; and the same numbers are available as a
 * real table to any reader who wants them, visually hidden rather than absent.
 * A picture is the fastest way to read this and must never be the only way.
 *
 * THE EMPTY AND SINGLE-POINT STATES ARE STATES, NOT BUGS. One day of history
 * cannot be drawn as an area, and no history at all is a fact about a young
 * deployment — both render a calm sentence instead of an axis with nothing on it.
 */
import { isUsablePoint, type IndependenceDayPoint } from '@owlat/shared/deliverabilityIndependence';
import { formatNumber, formatShortDate } from '~/utils/formatters';

const props = defineProps<{
	points: readonly IndependenceDayPoint[];
	/** `false` collapses the legend to one band: there is no relay to stack. */
	hasReference: boolean;
	labelledBy: string;
}>();

const { t } = useI18n();

// A DOCUMENT-UNIQUE PATTERN ID. `url(#…)` resolves against the whole document,
// so a hardcoded id means a second chart on the page silently paints with the
// first one's pattern.
const hatchId = useId();

const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 180;
const PADDING = { top: 8, right: 8, bottom: 20, left: 8 };
const innerWidth = VIEW_WIDTH - PADDING.left - PADDING.right;
const innerHeight = VIEW_HEIGHT - PADDING.top - PADDING.bottom;

// THE SHARED PREDICATE, NOT A LOCAL ONE. See `isUsablePoint`: the server's
// headline share already drops these days, so filtering them differently here is
// how the chart and the number above it come to describe different traffic.
const usable = computed(() => props.points.filter(isUsablePoint));

const peak = computed(() =>
	usable.value.reduce((max, point) => Math.max(max, point.own + point.reference), 0)
);

const hasArea = computed(() => usable.value.length >= 2 && peak.value > 0);

interface PlottedPoint {
	x: number;
	ownY: number;
	totalY: number;
}

const plotted = computed<PlottedPoint[]>(() => {
	const points = usable.value;
	if (!hasArea.value) return [];
	const span = points.length - 1;
	const scale = peak.value;
	return points.map((point, index) => {
		const x = PADDING.left + (index / span) * innerWidth;
		const total = point.own + point.reference;
		return {
			x,
			ownY: PADDING.top + innerHeight - (point.own / scale) * innerHeight,
			totalY: PADDING.top + innerHeight - (total / scale) * innerHeight,
		};
	});
});

const baseline = PADDING.top + innerHeight;

function areaPath(upper: (point: PlottedPoint) => number, lower: (point: PlottedPoint) => number) {
	const points = plotted.value;
	const first = points[0];
	const last = points[points.length - 1];
	if (first === undefined || last === undefined) return '';
	const forward = points.map((point) => `L ${point.x},${upper(point)}`).join(' ');
	const back = [...points]
		.reverse()
		.map((point) => `L ${point.x},${lower(point)}`)
		.join(' ');
	return `M ${first.x},${upper(first)} ${forward} ${back} Z`;
}

/** The own-server band: from the baseline up to the own-arm volume. */
const ownArea = computed(() =>
	areaPath(
		(point) => point.ownY,
		() => baseline
	)
);
/** The relay band: stacked directly on top of the own band. */
const referenceArea = computed(() =>
	areaPath(
		(point) => point.totalY,
		(point) => point.ownY
	)
);

const firstLabel = computed(() => {
	const point = usable.value[0];
	return point === undefined ? '' : formatShortDate(point.day);
});
const lastLabel = computed(() => {
	const point = usable.value[usable.value.length - 1];
	return point === undefined ? '' : formatShortDate(point.day);
});

const summary = computed(() => {
	if (usable.value.length === 0) return t('components.delivery.independenceTrendChart.noSending');
	const own = usable.value.reduce((total, point) => total + point.own, 0);
	const reference = usable.value.reduce((total, point) => total + point.reference, 0);
	return props.hasReference
		? t('components.delivery.independenceTrendChart.summaryWithRelay', {
				days: usable.value.length,
				own: formatNumber(own),
				reference: formatNumber(reference),
			})
		: t('components.delivery.independenceTrendChart.summary', {
				days: usable.value.length,
				own: formatNumber(own),
			});
});
</script>

<template>
	<figure class="m-0" :aria-labelledby="labelledBy">
		<div v-if="!hasArea" class="rounded-lg border border-border-subtle p-4">
			<p class="text-sm text-text-secondary" data-testid="independence-chart-empty">
				{{
					usable.length === 0
						? t('components.delivery.independenceTrendChart.emptyNothingSent')
						: t('components.delivery.independenceTrendChart.emptyOneDay')
				}}
			</p>
		</div>

		<svg
			v-else
			:viewBox="`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`"
			class="h-44 w-full"
			role="img"
			:aria-label="summary"
			data-testid="independence-chart"
		>
			<defs>
				<!--
					HATCHING, NOT ONLY COLOUR. The relay band is distinguishable from the
					own-server band without any colour perception at all.
				-->
				<pattern
					:id="hatchId"
					width="6"
					height="6"
					patternUnits="userSpaceOnUse"
					patternTransform="rotate(45)"
				>
					<line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" stroke-width="2" />
				</pattern>
			</defs>
			<path :d="ownArea" fill="var(--color-brand)" fill-opacity="0.7" data-testid="own-band" />
			<path
				v-if="hasReference"
				:d="referenceArea"
				:fill="`url(#${hatchId})`"
				class="text-text-secondary"
				fill-opacity="0.5"
				data-testid="reference-band"
			/>
			<line
				:x1="PADDING.left"
				:y1="baseline"
				:x2="VIEW_WIDTH - PADDING.right"
				:y2="baseline"
				stroke="currentColor"
				class="text-border-subtle"
			/>
		</svg>

		<figcaption class="mt-2 flex items-center justify-between text-xs text-text-secondary">
			<span>{{ firstLabel }}</span>
			<span class="flex items-center gap-3">
				<span class="flex items-center gap-1">
					<span class="inline-block h-2 w-4 rounded-sm bg-brand" aria-hidden="true" />
					{{ t('components.delivery.independenceTrendChart.ownServer') }}
				</span>
				<span v-if="hasReference" class="flex items-center gap-1">
					<span
						class="inline-block h-2 w-4 rounded-sm border border-dashed border-text-secondary"
						aria-hidden="true"
					/>
					{{ t('components.delivery.independenceTrendChart.relay') }}
				</span>
			</span>
			<span>{{ lastLabel }}</span>
		</figcaption>

		<!-- The same numbers, for anyone who cannot or would rather not read a picture. -->
		<table v-if="usable.length > 0" class="sr-only">
			<caption>
				{{
					summary
				}}
			</caption>
			<thead>
				<tr>
					<th scope="col">{{ t('components.delivery.independenceTrendChart.day') }}</th>
					<th scope="col">{{ t('components.delivery.independenceTrendChart.ownServer') }}</th>
					<th v-if="hasReference" scope="col">
						{{ t('components.delivery.independenceTrendChart.relay') }}
					</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="point in usable" :key="point.day">
					<th scope="row">{{ formatShortDate(point.day) }}</th>
					<td>{{ formatNumber(point.own) }}</td>
					<td v-if="hasReference">{{ formatNumber(point.reference) }}</td>
				</tr>
			</tbody>
		</table>
	</figure>
</template>
