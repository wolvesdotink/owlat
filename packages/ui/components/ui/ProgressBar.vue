<script setup lang="ts">
type ProgressVariant = 'brand' | 'success' | 'warning' | 'error';

interface Props {
	/** 0–100. Ignored when `indeterminate` is true. */
	value?: number;
	variant?: ProgressVariant;
	/** Animated sweep for unknown-duration work (e.g. "discovering"). */
	indeterminate?: boolean;
	/** Track height. */
	size?: 'sm' | 'md';
	/** Accessible name for the bar (announced by screen readers). */
	ariaLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
	value: 0,
	variant: 'brand',
	indeterminate: false,
	size: 'md',
});

const clamped = computed(() => Math.max(0, Math.min(100, Math.round(props.value))));

const fillColor: Record<ProgressVariant, string> = {
	brand: 'bg-brand',
	success: 'bg-success',
	warning: 'bg-warning',
	error: 'bg-error',
};

const trackHeight = computed(() => (props.size === 'sm' ? 'h-1.5' : 'h-2.5'));
</script>

<template>
	<div
		class="w-full rounded-full bg-text-tertiary/15 overflow-hidden"
		:class="trackHeight"
		role="progressbar"
		:aria-label="ariaLabel"
		:aria-valuenow="indeterminate ? undefined : clamped"
		:aria-valuetext="indeterminate ? 'Loading…' : undefined"
		aria-valuemin="0"
		aria-valuemax="100"
	>
		<div
			v-if="indeterminate"
			class="h-full w-1/3 rounded-full progress-indeterminate"
			:class="fillColor[variant]"
		/>
		<div
			v-else
			class="h-full rounded-full transition-[width] duration-(--motion-slow) ease-spring"
			:class="fillColor[variant]"
			:style="{ width: `${clamped}%` }"
		/>
	</div>
</template>

<style scoped>
@keyframes progress-sweep {
	0% {
		transform: translateX(-100%);
	}
	100% {
		transform: translateX(400%);
	}
}
.progress-indeterminate {
	animation: progress-sweep 1.4s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
	.progress-indeterminate {
		animation-duration: 3s;
	}
}
</style>
