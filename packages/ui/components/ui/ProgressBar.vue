<script setup lang="ts">
/**
 * Determinate or indeterminate progress track.
 *
 * Neither state touches layout while it moves: the determinate fill is a
 * full-width layer slid in with `transform` (`.ui-meter-fill`), and the
 * indeterminate sweep is a stepped `transform` loop that runs only while the
 * bar is on screen in a visible tab. Under reduced motion the sweep stops and
 * parks in the middle of the track.
 */
import { ref } from 'vue';
import { useUiI18n } from '../../composables/useUiI18n';
import { useVisibleAnimation } from '../../composables/useVisibleAnimation';
import { meterFillStyle } from '../../utils/meterFill';

type ProgressVariant = 'brand' | 'success' | 'warning' | 'error';

interface Props {
	/** 0–100. Ignored when `indeterminate` is true. */
	value?: number;
	variant?: ProgressVariant;
	/** Animated sweep for unknown-duration work (e.g. "discovering"). */
	indeterminate?: boolean;
	/** Track height. */
	size?: 'sm' | 'md';
	/** Accessible name for the bar (announced by screen readers). */
	ariaLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
	value: 0,
	variant: 'brand',
	indeterminate: false,
	size: 'md',
});

const { t } = useUiI18n();

const clamped = computed(() => Math.max(0, Math.min(100, Math.round(props.value))));

const fillColor: Record<ProgressVariant, string> = {
	brand: 'bg-brand',
	success: 'bg-success',
	warning: 'bg-warning',
	error: 'bg-error',
};

const trackHeight = computed(() => (props.size === 'sm' ? 'h-1.5' : 'h-2.5'));

// Observe the stationary track, not the sweep: the sweep slides out of the
// viewport mid-cycle on a wide bar, and pausing it there would leave an empty
// track. The sweep reads the track's play state through the inherited custom
// property.
const track = ref<HTMLElement | null>(null);
useVisibleAnimation(track, () => props.indeterminate);
</script>

<template>
	<div
		ref="track"
		class="w-full rounded-full bg-text-tertiary/15 overflow-hidden"
		:class="trackHeight"
		role="progressbar"
		:aria-label="ariaLabel"
		:aria-valuenow="indeterminate ? undefined : clamped"
		:aria-valuetext="indeterminate ? t('ui.progress.loading') : undefined"
		aria-valuemin="0"
		aria-valuemax="100"
	>
		<div
			v-if="indeterminate"
			class="h-full w-1/3 rounded-full progress-indeterminate"
			:class="fillColor[variant]"
		/>
		<div
			v-else
			class="ui-meter-fill h-full rounded-full transition-transform duration-(--motion-slow) ease-spring"
			:class="fillColor[variant]"
			:style="meterFillStyle(clamped)"
		/>
	</div>
</template>

<style scoped>
@keyframes progress-sweep {
	0% {
		transform: translateX(-100%);
	}
	100% {
		transform: translateX(400%);
	}
}
.progress-indeterminate {
	transform: translateX(-100%);
	animation: progress-sweep 1.4s steps(21) infinite;
	animation-play-state: var(--ui-animation-state, paused);
}
/* No sweep at all, not a slower one: the global reduced-motion floor shrinks
 * the duration to nothing, which would turn an infinite loop into a strobe.
 * The parked middle third still reads as "working, amount unknown". */
@media (prefers-reduced-motion: reduce) {
	.progress-indeterminate {
		animation: none;
		transform: translateX(100%);
	}
}

/* The app's own "Reduce motion" setting (the data-motion floor in base.css). */
:root[data-motion='reduce'] .progress-indeterminate {
	animation: none;
	transform: translateX(100%);
}
</style>
