<script setup lang="ts">
type StatCardVariant = 'default' | 'success' | 'warning' | 'error' | 'secondary';

interface Props {
	value: string | number;
	label: string;
	variant?: StatCardVariant;
}

const props = withDefaults(defineProps<Props>(), {
	variant: 'default',
});

const variantClasses: Record<StatCardVariant, string> = {
	default: 'text-brand',
	success: 'text-success',
	warning: 'text-warning',
	error: 'text-error',
	secondary: 'text-text-secondary',
};

const valueClass = computed(() => {
	return ['text-2xl', 'font-semibold', variantClasses[props.variant]].join(' ');
});
</script>

<template>
	<div class="p-4 rounded-lg bg-bg-surface text-center">
		<p :class="valueClass">{{ value }}</p>
		<p class="text-xs text-text-tertiary mt-1">{{ label }}</p>
	</div>
</template>
