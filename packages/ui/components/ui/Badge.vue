<script setup lang="ts">
type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'neutral';
type BadgeSize = 'sm' | 'md';

interface Props {
	variant?: BadgeVariant;
	size?: BadgeSize;
	dot?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	variant: 'default',
	size: 'sm',
	dot: false,
});

const variantClasses: Record<BadgeVariant, { bg: string; text: string; dot: string }> = {
	default: { bg: 'bg-brand/10', text: 'text-brand', dot: 'bg-brand' },
	success: { bg: 'bg-success/10', text: 'text-success', dot: 'bg-success' },
	warning: { bg: 'bg-warning/10', text: 'text-warning', dot: 'bg-warning' },
	error: { bg: 'bg-error/10', text: 'text-error', dot: 'bg-error' },
	neutral: { bg: 'bg-text-tertiary/10', text: 'text-text-tertiary', dot: 'bg-text-tertiary' },
};

const sizeClasses: Record<BadgeSize, string> = {
	sm: 'px-1.5 py-0.5',
	md: 'px-2 py-1',
};

const badgeClasses = computed(() => {
	const variant = variantClasses[props.variant];
	const classes = ['inline-flex', 'items-center', 'gap-1', 'rounded', 'text-xs', 'font-medium'];

	if (props.dot) {
		// Dot mode: smaller padding, no background
		classes.push('gap-1.5', 'px-0', variant.text);
	} else {
		classes.push(sizeClasses[props.size], variant.bg, variant.text);
	}

	return classes.join(' ');
});

const dotClasses = computed(() => {
	const variant = variantClasses[props.variant];
	return ['w-1.5', 'h-1.5', 'rounded-full', variant.dot].join(' ');
});
</script>

<template>
	<span :class="badgeClasses">
		<span v-if="dot" :class="dotClasses" />
		<slot name="icon" />
		<slot />
	</span>
</template>
