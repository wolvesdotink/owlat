<script setup lang="ts">
type CardPadding = 'none' | 'sm' | 'md' | 'lg';
type CardVariant = 'default' | 'info' | 'warning' | 'error';
type CardOverflow = 'visible' | 'hidden';

interface Props {
	padding?: CardPadding;
	variant?: CardVariant;
	hoverable?: boolean;
	clickable?: boolean;
	overflow?: CardOverflow;
}

const props = withDefaults(defineProps<Props>(), {
	padding: 'md',
	variant: 'default',
	hoverable: false,
	clickable: false,
	overflow: 'visible',
});

const emit = defineEmits<{
	click: [event: MouseEvent];
}>();

const handleClick = (event: MouseEvent) => {
	if (props.clickable) {
		emit('click', event);
	}
};

const paddingClasses: Record<CardPadding, string> = {
	none: 'p-0',
	sm: 'p-4',
	md: 'p-6', // Default from .card class
	lg: 'p-8',
};

// Default carries elevation via the surface ladder (shadow ring); the
// transparent border keeps the box metrics and lets consumer border-color
// overrides (e.g. border-error/20) keep rendering their tinted edge.
// Tinted status variants keep their translucent border for the colored edge.
const variantClasses: Record<CardVariant, string> = {
	default: 'bg-surface-2 shadow-surface-1 border border-transparent',
	info: 'bg-brand/5 border border-brand/20',
	warning: 'bg-warning/5 border border-warning/20',
	error: 'bg-error/5 border border-error/20',
};

const cardClasses = computed(() => {
	const classes = [
		'rounded-(--radius-card) transition-[color,background-color,border-color,box-shadow] duration-(--motion-fast) ease-spring',
		variantClasses[props.variant],
	];

	// Only add padding class, not the default p-6 from .card since we override it
	classes.push(paddingClasses[props.padding]);

	// Overflow
	if (props.overflow === 'hidden') {
		classes.push('overflow-hidden');
	}

	// Hover/clickable states: the default variant lifts one elevation step;
	// tinted variants highlight their border.
	if (props.hoverable || props.clickable) {
		classes.push(props.variant === 'default' ? 'hover:shadow-surface-2' : 'hover:border-brand');
	}

	if (props.clickable) {
		classes.push('cursor-pointer');
	}

	return classes.join(' ');
});

const slots = useSlots();
</script>

<template>
	<div :class="cardClasses" @click="handleClick">
		<!-- Header slot with automatic border -->
		<div
			v-if="slots['header']"
			class="border-b border-border-subtle"
			:class="{ 'p-6': padding === 'none' }"
		>
			<slot name="header" />
		</div>

		<!-- Main content -->
		<slot />

		<!-- Footer slot with automatic border -->
		<div
			v-if="slots['footer']"
			class="border-t border-border-subtle mt-auto"
			:class="{ 'p-6': padding === 'none' }"
		>
			<slot name="footer" />
		</div>
	</div>
</template>
