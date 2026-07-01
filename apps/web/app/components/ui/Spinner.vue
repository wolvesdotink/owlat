<script setup lang="ts">
import {
	SPINNER_SIZE_CLASSES,
	DEFAULT_SPINNER_SIZE,
	type SpinnerSize,
} from './spinnerSizes';

const props = withDefaults(
	defineProps<{
		/** Diameter of the spinner. Defaults to `lg` (w-8 h-8). */
		size?: SpinnerSize;
	}>(),
	{
		size: DEFAULT_SPINNER_SIZE,
	},
);

const sizeClass = computed(() => SPINNER_SIZE_CLASSES[props.size]);
</script>

<template>
	<div
		class="border-2 border-brand border-t-transparent rounded-full animate-spin"
		:class="sizeClass"
	/>
</template>
