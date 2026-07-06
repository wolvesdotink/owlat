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
const reducedMotion = ref(false);

onMounted(() => {
	if (el.value) {
		durationMs.value = parseCssDurationMs(
			getComputedStyle(el.value).getPropertyValue('--motion-moderate'),
			durationMs.value
		);
	}
	if (typeof matchMedia === 'function') {
		const query = matchMedia('(prefers-reduced-motion: reduce)');
		reducedMotion.value = query.matches;
		query.addEventListener('change', (event) => {
			reducedMotion.value = event.matches;
		});
	}
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
