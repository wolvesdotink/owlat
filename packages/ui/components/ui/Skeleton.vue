<script setup lang="ts">
/**
 * Neutral shimmer placeholder block for loading states.
 *
 * Size it from the consumer with utility classes (w-* / h-*); the component
 * only supplies the surface and the animation. The shimmer is a subtle
 * currentColor sweep so it adapts to light/dark themes, and it is disabled
 * entirely under prefers-reduced-motion (static block fallback). A page of
 * placeholders can hold dozens of these, most of them below the fold, so the
 * sweep steps through a few frames and runs only while the block is on screen
 * in a visible tab (`useVisibleAnimation`).
 *
 * The fill is `bg-bg-surface`, NOT `bg-bg-elevated`. `--color-bg-elevated` is
 * `--surface-2`, which is the exact background `UiCard` paints, so an elevated
 * skeleton inside a card would be invisible and invite hand-rolled pulsing
 * divs in its place. `--color-bg-surface` is deliberately kept a visible step
 * against base (`--surface-1`), elevated (`--surface-2`) and white parents in
 * both themes (see the note in `assets/css/light.css`), so the placeholder
 * reads on the page background AND inside a card.
 */
import { ref } from 'vue';
import { useVisibleAnimation } from '../../composables/useVisibleAnimation';

withDefaults(
	defineProps<{
		/** Render as a circle (avatar placeholder) instead of a rounded bar. */
		circle?: boolean;
	}>(),
	{ circle: false }
);

const root = ref<HTMLElement | null>(null);
useVisibleAnimation(root);
</script>

<template>
	<div
		ref="root"
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
	animation: ui-skeleton-shimmer 1.6s steps(24) infinite;
	animation-play-state: var(--ui-animation-state, paused);
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

/* The app's own "Reduce motion" setting (the data-motion floor in base.css). */
:root[data-motion='reduce'] .ui-skeleton::after {
	animation: none;
}
</style>
