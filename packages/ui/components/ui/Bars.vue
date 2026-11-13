<script setup lang="ts">
/**
 * UiBars — thin vertical bars anchored to the baseline, single hue by
 * default, per-bar tooltip on hover AND keyboard focus (opacity-only reveal,
 * zero layout shift). Optional sparse x-axis labels via labelEvery.
 */
import { computeBarHeightPercent, type ChartDatum } from '../../utils/chart';
import { useUiI18n } from '../../composables/useUiI18n';

interface Props {
	data: ChartDatum[];
	color?: string;
	/** Plot height in px (labels render below and add to the total height). */
	height?: number;
	/** Show every Nth x label (last is always shown). 0 hides labels. */
	labelEvery?: number;
	formatValue?: (value: number) => string;
	/** Accessible name for the plot. Defaults to the localized "Bar chart". */
	ariaLabel?: string;
}

// `ariaLabel` has no default: prop defaults are evaluated outside the setup
// context, where `useUiI18n()` cannot run. It is resolved below instead.
const props = withDefaults(defineProps<Props>(), {
	color: 'var(--color-brand)',
	height: 128,
	labelEvery: 0,
	formatValue: (value: number) => value.toLocaleString(),
	ariaLabel: undefined,
});

const { t } = useUiI18n();

const resolvedAriaLabel = computed(() => props.ariaLabel ?? t('ui.chart.barsAriaLabel'));

const maxValue = computed(() => Math.max(...props.data.map((d) => d.value), 0));

// One tab stop for the whole chart: a 90-day series would otherwise cost a
// keyboard user 90 Tab presses to get past it. Arrow keys move between bars.
const activeIndex = ref(0);
const barRefs = shallowRef<HTMLElement[]>([]);
const setBarRef = (el: unknown, index: number) => {
	if (el) barRefs.value[index] = el as HTMLElement;
};

watch(
	() => props.data.length,
	(length) => {
		if (activeIndex.value >= length) activeIndex.value = Math.max(length - 1, 0);
	}
);

const onBarKeydown = (event: KeyboardEvent, index: number) => {
	const last = props.data.length - 1;
	let next = index;
	if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = Math.min(index + 1, last);
	else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = Math.max(index - 1, 0);
	else if (event.key === 'Home') next = 0;
	else if (event.key === 'End') next = last;
	else return;
	event.preventDefault();
	activeIndex.value = next;
	barRefs.value[next]?.focus();
};

const showLabelAt = (index: number) =>
	props.labelEvery > 0 && (index % props.labelEvery === 0 || index === props.data.length - 1);
</script>

<template>
	<div
		v-if="data.length === 0"
		class="flex items-center justify-center bg-bg-surface rounded-lg"
		:style="{ height: `${height}px` }"
	>
		<p class="text-sm text-text-tertiary">{{ t('ui.chart.empty') }}</p>
	</div>
	<div v-else role="group" :aria-label="resolvedAriaLabel">
		<div class="flex items-end gap-0.5" :style="{ height: `${height}px` }">
			<div
				v-for="(bar, index) in data"
				:key="`${bar.label}-${index}`"
				:ref="(el) => setBarRef(el, index)"
				class="group relative flex-1 min-w-0 h-full flex items-end rounded focus-visible:outline-2 focus-visible:outline-brand"
				:tabindex="index === activeIndex ? 0 : -1"
				role="img"
				:aria-label="`${bar.label}: ${formatValue(bar.value)}`"
				@keydown="onBarKeydown($event, index)"
				@focus="activeIndex = index"
			>
				<div
					class="w-full rounded-t transition-opacity duration-(--motion-fast)"
					:style="
						bar.value > 0
							? {
									height: `${computeBarHeightPercent(bar.value, maxValue)}%`,
									backgroundColor: color,
								}
							: { height: '2px', backgroundColor: 'var(--chart-grid)' }
					"
				/>
				<!-- Tooltip: hover or keyboard focus; opacity-only, never intercepts -->
				<div
					class="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-10 pointer-events-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-(--motion-fast) rounded-md bg-bg-overlay shadow-surface-4 px-2 py-1 whitespace-nowrap"
					aria-hidden="true"
				>
					<p class="text-2xs text-text-tertiary leading-tight">{{ bar.label }}</p>
					<p class="text-xs font-semibold text-text-primary tabular-nums leading-tight">
						{{ formatValue(bar.value) }}
					</p>
				</div>
			</div>
		</div>
		<!-- Sparse x-axis labels -->
		<div v-if="labelEvery > 0" class="flex gap-0.5 mt-2">
			<div
				v-for="(bar, index) in data"
				:key="`label-${bar.label}-${index}`"
				class="flex-1 min-w-0 text-center"
			>
				<span
					v-if="showLabelAt(index)"
					class="text-2xs text-text-tertiary tabular-nums whitespace-nowrap"
				>
					{{ bar.label }}
				</span>
			</div>
		</div>
	</div>
</template>
