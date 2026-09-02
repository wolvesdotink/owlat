<script setup lang="ts">
/**
 * Neutral shimmer placeholder block for loading states.
 *
 * Size it from the consumer with utility classes (w-* / h-*); the component
 * only supplies the surface and the animation. The shimmer is a subtle
 * currentColor sweep so it adapts to light/dark themes, and it is disabled
 * entirely under prefers-reduced-motion (static block fallback).
 *
 * The fill is `bg-bg-surface`, NOT `bg-bg-elevated`. `--color-bg-elevated` is
 * `--surface-2`, which is the exact background `UiCard` paints, so a skeleton
 * inside a card used to be invisible — which is why ~29 blocks across the app
 * hand-rolled a pulsing `bg-bg-surface` div instead of using this component.
 * `--color-bg-surface` is deliberately kept a visible step against base
 * (`--surface-1`), elevated (`--surface-2`) and white parents in both themes
 * (see the note in `assets/css/light.css`), so the placeholder reads on the
 * page background AND inside a card.
 */
withDefaults(
	defineProps<{
		/** Render as a circle (avatar placeholder) instead of a rounded bar. */
		circle?: boolean;
	}>(),
	{ circle: false },
);
</script>

<template>
	<div
		aria-hidden="true"
		class="ui-skeleton bg-bg-surface"
		:class="circle ? 'rounded-full' : 'rounded'"
	/>
</template>

<style scoped>
.ui-skeleton {
	position: relative;
	overflow: hidden;
}

.ui-skeleton::after {
	content: '';
	position: absolute;
	inset: 0;
	transform: translateX(-100%);
	background: linear-gradient(
		90deg,
		transparent,
		color-mix(in srgb, currentColor 8%, transparent),
		transparent
	);
	animation: ui-skeleton-shimmer 1.6s ease-in-out infinite;
}

@keyframes ui-skeleton-shimmer {
	100% {
		transform: translateX(100%);
	}
}

@media (prefers-reduced-motion: reduce) {
	.ui-skeleton::after {
		animation: none;
	}
}
</style>
