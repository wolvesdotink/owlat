<script setup lang="ts">
type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASSES: Record<SpinnerSize, string> = {
	xs: 'w-4 h-4',
	sm: 'w-5 h-5',
	md: 'w-6 h-6',
	lg: 'w-8 h-8',
	xl: 'w-12 h-12',
};

const props = withDefaults(
	defineProps<{
		/** Diameter of the spinner. Defaults to `lg` (w-8 h-8). */
		size?: SpinnerSize;
	}>(),
	{
		size: 'lg',
	},
);

const sizeClass = computed(() => SIZE_CLASSES[props.size]);
</script>

<template>
	<div
		class="border-2 border-brand border-t-transparent rounded-full animate-spin"
		:class="sizeClass"
	/>
</template>
