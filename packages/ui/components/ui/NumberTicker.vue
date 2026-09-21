<script setup lang="ts">
/**
 * Animated numeral for stat tiles and counters: when `value` changes, the
 * displayed number rolls to the new value over one moderate-tier beat
 * (--motion-moderate, read from the element so theme tokens stay the single
 * source of truth). Always tabular-nums so digits never jitter horizontally.
 * Under prefers-reduced-motion the number simply updates — plain text, no
 * animation.
 */
import { onMounted, ref } from 'vue';
import { parseCssDurationMs, useNumberTicker } from '../../composables/useNumberTicker';
import { useReducedMotion } from '../../composables/useReducedMotion';

const props = withDefaults(
	defineProps<{
		value: number;
		/** Optional display format (e.g. percentages). Default: rounded + grouped. */
		formatter?: (value: number) => string;
	}>(),
	{ formatter: undefined }
);

const el = ref<HTMLElement | null>(null);
const durationMs = ref(160);
// Set up at SETUP, not in `onMounted`: the old inline `matchMedia` wiring
// registered its `onBeforeUnmount` from inside a mount hook, so the listener
// outlived the component whenever the hook's guard did not run.
const reducedMotion = useReducedMotion();

onMounted(() => {
	if (!el.value) return;
	durationMs.value = parseCssDurationMs(
		getComputedStyle(el.value).getPropertyValue('--motion-moderate'),
		durationMs.value
	);
});

const { display } = useNumberTicker(() => props.value, {
	formatter: props.formatter,
	durationMs: () => durationMs.value,
	reducedMotion: () => reducedMotion.value,
});
</script>

<template>
	<span ref="el" class="tabular-nums">{{ display }}</span>
</template>
