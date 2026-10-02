<script setup lang="ts">
/**
 * Daily DMARC volume, each day one bar: mail that passed DMARC at the bottom,
 * mail that failed stacked on top.
 *
 * The failing segment is hatched as well as tinted, so passed and failed stay
 * apart without colour (red/green is the pair colour-blind readers lose). Each
 * bar names its day and both counts on hover and keyboard focus, and the same
 * numbers sit in a visually hidden table.
 *
 * Days are the backend's UTC day keys, so they are labelled in UTC: a local-time
 * label would give every reader west of UTC the previous day's date.
 */
import { trendBars } from '~/utils/dmarcReportView';
import { formatNumber, formatUtcDayKey } from '~/utils/formatters';

const props = defineProps<{
	points: ReadonlyArray<{ date: string; messageCount: number; alignedCount: number }>;
}>();

const { t, locale } = useI18n();

const bars = computed(() => trendBars(props.points));
const hasVolume = computed(() => bars.value.some((bar) => bar.passed + bar.failed > 0));
const activeIndex = ref<number | null>(null);
const active = computed(() =>
	activeIndex.value === null ? null : (bars.value[activeIndex.value] ?? null)
);

// Centred over the active bar, kept inside the chart at the edges.
const tooltipLeft = computed(() => {
	if (activeIndex.value === null || bars.value.length === 0) return '50%';
	const centre = ((activeIndex.value + 0.5) / bars.value.length) * 100;
	return `${Math.min(88, Math.max(12, centre))}%`;
});

function countsLine(bar: { passed: number; failed: number }): string {
	return t('components.delivery.dmarcTrendChart.tooltip', {
		passed: formatNumber(bar.passed, locale.value),
		failed: formatNumber(bar.failed, locale.value),
	});
}

const firstLabel = computed(() => {
	const first = bars.value[0];
	return first ? formatUtcDayKey(first.date, locale.value) : '';
});
const lastLabel = computed(() => {
	const last = bars.value[bars.value.length - 1];
	return last ? formatUtcDayKey(last.date, locale.value) : '';
});
</script>

<template>
	<figure class="m-0">
		<div
			v-if="!hasVolume"
			class="rounded-lg border border-border-subtle p-4 text-sm text-text-secondary"
			data-testid="dmarc-trend-empty"
		>
			{{ t('components.delivery.dmarcTrendChart.empty') }}
		</div>

		<template v-else>
			<div class="relative">
				<!-- Tooltip for the hovered / focused day. -->
				<div
					class="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-border-subtle bg-bg-elevated px-2.5 py-1.5 text-xs shadow-sm transition-opacity"
					:class="active ? 'opacity-100' : 'opacity-0'"
					:style="{ left: tooltipLeft }"
					aria-hidden="true"
				>
					<template v-if="active">
						<p class="font-medium text-text-primary">
							{{ formatUtcDayKey(active.date, locale) }}
						</p>
						<p class="text-text-secondary">{{ countsLine(active) }}</p>
					</template>
				</div>

				<!-- A group, not an image: its bars take keyboard focus, and an image's
				     children are presentational. -->
				<div
					class="flex h-36 items-end gap-0.5 border-b border-border-subtle"
					role="group"
					:aria-label="t('components.delivery.dmarcTrendChart.label')"
					data-testid="dmarc-trend"
				>
					<div
						v-for="(bar, index) in bars"
						:key="bar.date"
						class="flex h-full min-w-0 flex-1 cursor-default flex-col justify-end rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-brand"
						tabindex="0"
						:aria-label="`${formatUtcDayKey(bar.date, locale)}: ${countsLine(bar)}`"
						data-testid="dmarc-trend-bar"
						@mouseenter="activeIndex = index"
						@mouseleave="activeIndex = null"
						@focus="activeIndex = index"
						@blur="activeIndex = null"
					>
						<div
							v-if="bar.failed > 0"
							class="dmarc-failed w-full rounded-t-sm"
							:class="bar.passed > 0 ? 'mb-0.5' : ''"
							:style="{ height: `${Math.max(bar.failedShare * 100, 2)}%` }"
						/>
						<div
							v-if="bar.passed > 0"
							class="w-full bg-success/70"
							:class="bar.failed > 0 ? '' : 'rounded-t-sm'"
							:style="{ height: `${Math.max(bar.passedShare * 100, 2)}%` }"
						/>
					</div>
				</div>
			</div>

			<figcaption class="mt-2 flex items-center justify-between gap-3 text-xs text-text-secondary">
				<span>{{ firstLabel }}</span>
				<span class="flex items-center gap-3">
					<span class="flex items-center gap-1">
						<span class="inline-block h-2 w-4 rounded-sm bg-success/70" aria-hidden="true" />
						{{ t('components.delivery.dmarcTrendChart.passed') }}
					</span>
					<span class="flex items-center gap-1">
						<span class="dmarc-failed inline-block h-2 w-4 rounded-sm" aria-hidden="true" />
						{{ t('components.delivery.dmarcTrendChart.failed') }}
					</span>
				</span>
				<span>{{ lastLabel }}</span>
			</figcaption>

			<table class="sr-only">
				<caption>
					{{
						t('components.delivery.dmarcTrendChart.label')
					}}
				</caption>
				<thead>
					<tr>
						<th scope="col">{{ t('components.delivery.dmarcTrendChart.day') }}</th>
						<th scope="col">{{ t('components.delivery.dmarcTrendChart.passed') }}</th>
						<th scope="col">{{ t('components.delivery.dmarcTrendChart.failed') }}</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="bar in bars" :key="bar.date">
						<th scope="row">{{ formatUtcDayKey(bar.date, locale) }}</th>
						<td>{{ formatNumber(bar.passed, locale) }}</td>
						<td>{{ formatNumber(bar.failed, locale) }}</td>
					</tr>
				</tbody>
			</table>
		</template>
	</figure>
</template>

<style scoped>
/* Failing mail: error tint plus a 45° hatch, so it never relies on colour alone. */
.dmarc-failed {
	background-color: color-mix(in srgb, var(--color-error) 75%, transparent);
	background-image: repeating-linear-gradient(
		45deg,
		transparent 0 3px,
		color-mix(in srgb, var(--color-bg-base) 45%, transparent) 3px 5px
	);
}
</style>
