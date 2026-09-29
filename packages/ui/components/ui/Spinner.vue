<script setup lang="ts">
import { computed } from 'vue';
import { DEFAULT_LOADING_DELAY_MS, useDelayedLoading } from '../../composables/useDelayedLoading';

type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
type SpinnerTone = 'brand' | 'inverse';

const SIZE_CLASSES: Record<SpinnerSize, string> = {
	xs: 'w-4 h-4',
	sm: 'w-5 h-5',
	md: 'w-6 h-6',
	lg: 'w-8 h-8',
	xl: 'w-12 h-12',
};

// `inverse` rides on a filled/brand surface (e.g. inside a primary button) where
// the brand ring would vanish; it inherits the host's foreground colour so the
// ring matches the button's own icon/text in both themes (text-inverse on
// btn-primary and btn-danger alike) — no baked-in hex.
const TONE_CLASSES: Record<SpinnerTone, string> = {
	brand: 'border-brand',
	inverse: 'border-current',
};

const props = withDefaults(
	defineProps<{
		/** Diameter of the spinner. Defaults to `lg` (w-8 h-8). */
		size?: SpinnerSize;
		/** Ring colour. Defaults to `brand`; use `inverse` on a filled surface. */
		tone?: SpinnerTone;
		/**
		 * Opt-in grace period before the ring appears: `true` for the shared
		 * 150 ms, or a number of ms. Until then the spinner keeps its box but
		 * paints nothing, so a wait that ends quickly never flashes a loader.
		 * Off by default: a spinner inside a button the user just pressed is
		 * feedback, and should show at once.
		 */
		delay?: boolean | number;
	}>(),
	{
		size: 'lg',
		tone: 'brand',
		delay: false,
	}
);

const sizeClass = computed(() => SIZE_CLASSES[props.size]);
const toneClass = computed(() => TONE_CLASSES[props.tone]);

/**
 * A mounted spinner is, by definition, a load in progress; the parent unmounts
 * it when the load ends, so only the delay half of `useDelayedLoading` applies.
 * The delay is read once: a spinner that is already spinning does not blink out
 * because a prop changed.
 */
const delayMs =
	props.delay === true ? DEFAULT_LOADING_DELAY_MS : props.delay === false ? 0 : props.delay;
const visible = useDelayedLoading(true, { delay: delayMs, minVisible: 0 });
</script>

<template>
	<div
		class="border-2 border-t-transparent rounded-full animate-spin motion-reduce:animate-none"
		:class="[sizeClass, toneClass, { invisible: !visible }]"
	/>
</template>
