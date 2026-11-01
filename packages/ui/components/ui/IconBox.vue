<script setup lang="ts">
import type { IconComponent } from '@coolicons/vue';

type Size = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
type Variant = 'brand' | 'success' | 'warning' | 'error' | 'surface' | 'inverse';
type Rounded = 'lg' | 'xl' | '2xl' | 'full';

interface Props {
	icon: IconComponent;
	size?: Size;
	variant?: Variant;
	rounded?: Rounded;
}

const props = withDefaults(defineProps<Props>(), {
	size: 'md',
	variant: 'brand',
	rounded: 'xl',
});

// A coolicons glyph is drawn with a 2px stroke on a 24px grid, so it scales
// with the box: at the 28px of `xl` it would render 2.33px wide and read as
// bold next to the 1.33px of the 16px icons around it. `stroke` pulls the
// large size back to the weight the rest of the app shows.
const sizeClasses: Record<Size, { box: string; icon: string; stroke?: number }> = {
	xs: { box: 'size-7', icon: 'size-3.5' },
	sm: { box: 'size-8', icon: 'size-4' },
	md: { box: 'size-9', icon: 'size-[18px]' },
	lg: { box: 'size-10', icon: 'size-5' },
	xl: { box: 'size-14', icon: 'size-7', stroke: 1.5 },
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
const iconStroke = computed(() => sizeClasses[props.size].stroke);
</script>

<template>
	<div :class="boxClasses">
		<component :is="icon" :class="iconClasses" :stroke-width="iconStroke" />
	</div>
</template>
