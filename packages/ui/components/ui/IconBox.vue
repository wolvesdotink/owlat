<script setup lang="ts">
type Size = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
type Variant = 'brand' | 'success' | 'warning' | 'error' | 'surface' | 'inverse';
type Rounded = 'lg' | 'xl' | '2xl' | 'full';

interface Props {
	icon: string;
	size?: Size;
	variant?: Variant;
	rounded?: Rounded;
}

const props = withDefaults(defineProps<Props>(), {
	size: 'md',
	variant: 'brand',
	rounded: 'xl',
});

const sizeClasses: Record<Size, { box: string; icon: string }> = {
	xs: { box: 'size-7', icon: 'size-3.5' },
	sm: { box: 'size-8', icon: 'size-4' },
	md: { box: 'size-9', icon: 'size-[18px]' },
	lg: { box: 'size-10', icon: 'size-5' },
	xl: { box: 'size-14', icon: 'size-7' },
};

const variantClasses: Record<Variant, string> = {
	brand: 'bg-brand-subtle text-brand',
	success: 'bg-success-subtle text-success',
	warning: 'bg-warning-subtle text-warning',
	error: 'bg-error-subtle text-error',
	surface: 'bg-bg-surface text-text-secondary',
	inverse: 'bg-brand text-text-inverse',
};

const roundedClasses: Record<Rounded, string> = {
	lg: 'rounded-lg',
	xl: 'rounded-xl',
	'2xl': 'rounded-2xl',
	full: 'rounded-full',
};

const boxClasses = computed(() => [
	'flex items-center justify-center shrink-0',
	sizeClasses[props.size].box,
	variantClasses[props.variant],
	roundedClasses[props.rounded],
]);

const iconClasses = computed(() => sizeClasses[props.size].icon);
</script>

<template>
	<div :class="boxClasses">
		<Icon :name="icon" :class="iconClasses" />
	</div>
</template>
