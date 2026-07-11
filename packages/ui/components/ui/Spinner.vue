<script setup lang="ts">
import { computed } from 'vue';

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
// btn-primary, white on text-white/bg-error buttons) — no baked-in hex.
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
	}>(),
	{
		size: 'lg',
		tone: 'brand',
	}
);

const sizeClass = computed(() => SIZE_CLASSES[props.size]);
const toneClass = computed(() => TONE_CLASSES[props.tone]);
</script>

<template>
	<div
		class="border-2 border-t-transparent rounded-full animate-spin"
		:class="[sizeClass, toneClass]"
	/>
</template>
