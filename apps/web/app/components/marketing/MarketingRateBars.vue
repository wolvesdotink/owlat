<script setup lang="ts">
/**
 * One rate, campaign by campaign — a small multiple. Two of these sit side by
 * side (open rate, click rate) over the same campaigns in the same order,
 * each with its own zero-based axis: never one dual-axis chart. Single hue,
 * bars capped at 24px with a 4px rounded top, a hairline grid, and a dashed
 * reference line at the average. Every bar shows its campaign and exact value
 * on hover AND keyboard focus.
 */
import { formatPercentage } from '~/utils/formatters';

const props = withDefaults(
	defineProps<{
		bars: readonly { id: string; label: string; value: number }[];
		average: number;
		ariaLabel: string;
		height?: number;
	}>(),
	{ height: 112 }
);

const { t } = useI18n();

/** Axis top: the largest value or the average, rounded up to a whole 5 points. */
const axisMax = computed(() => {
	const peak = Math.max(props.average, ...props.bars.map((b) => b.value), 0);
	if (peak <= 0) return 0.05;
	return Math.ceil(peak / 0.05) * 0.05;
});

function heightPercent(value: number): number {
	return Math.max(0, Math.min(100, (value / axisMax.value) * 100));
}

const averageLabel = computed(() =>
	t('components.marketing.rateBars.average', { value: formatPercentage(props.average, 1) })
);
</script>

<template>
	<div role="group" :aria-label="ariaLabel">
		<div class="relative" :style="{ height: `${height}px` }">
			<!-- Hairline grid: top and middle of the axis, baseline below. -->
			<div class="absolute inset-x-0 top-0 border-t border-border-subtle" aria-hidden="true" />
			<div class="absolute inset-x-0 top-1/2 border-t border-border-subtle" aria-hidden="true" />
			<div class="absolute inset-x-0 bottom-0 border-t border-border-default" aria-hidden="true" />
			<span
				class="absolute -top-2 right-0 text-[10px] tabular-nums text-text-tertiary bg-bg-elevated pl-1"
				aria-hidden="true"
			>
				{{ formatPercentage(axisMax, 0) }}
			</span>

			<div class="absolute inset-0 flex items-end justify-around gap-1 px-1">
				<div
					v-for="bar in bars"
					:key="bar.id"
					class="group relative flex-1 max-w-6 h-full flex items-end rounded focus-visible:outline-2 focus-visible:outline-brand"
					tabindex="0"
					role="img"
					:aria-label="`${bar.label}: ${formatPercentage(bar.value, 1)}`"
				>
					<div
						class="w-full rounded-t bg-brand"
						:style="{ height: bar.value > 0 ? `${heightPercent(bar.value)}%` : '2px' }"
					/>
					<div
						class="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-10 pointer-events-none opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-(--motion-fast) rounded-md bg-bg-overlay shadow-surface-4 px-2 py-1 whitespace-nowrap"
						aria-hidden="true"
					>
						<p class="text-[10px] text-text-tertiary leading-tight">{{ bar.label }}</p>
						<p class="text-xs font-semibold text-text-primary tabular-nums leading-tight">
							{{ formatPercentage(bar.value, 1) }}
						</p>
					</div>
				</div>
			</div>

			<!-- Average reference line, labelled in text so it never relies on the dash alone. -->
			<div
				class="absolute inset-x-0 border-t border-dashed border-text-tertiary pointer-events-none"
				:style="{ bottom: `${heightPercent(average)}%` }"
				aria-hidden="true"
			/>
		</div>
		<p class="mt-2 text-[11px] text-text-tertiary tabular-nums">{{ averageLabel }}</p>
	</div>
</template>
