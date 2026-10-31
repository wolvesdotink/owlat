<script setup lang="ts">
/**
 * The two connectors of `ArchSystem`: labelled lines between the frontend and
 * the backend, and the fork from the backend to delivery and webhooks. Each
 * variant is a whole root element: a `v-if` on the inner parts would leave a
 * `<!---->` placeholder in the other variant's markup.
 */
defineProps<{
	variant: 'labels' | 'fork';
	/** Entrance stagger step, shared with the neighbouring section. */
	stagger: number;
}>();
</script>

<template>
	<div v-if="variant === 'labels'" class="arch-connector" :style="{ '--stagger': stagger }">
		<div class="arch-connector-line" />
		<div class="arch-connector-labels">
			<span>Real-time subscriptions</span>
			<span>Mutations / Actions</span>
		</div>
		<div class="arch-connector-line" />
	</div>
	<div v-else class="arch-connector" :style="{ '--stagger': stagger }">
		<div class="arch-connector-line" />
		<div class="arch-connector-fork">
			<div class="arch-fork-bar" />
			<div class="arch-fork-branches">
				<div class="arch-fork-line" />
				<div class="arch-fork-line" />
			</div>
		</div>
	</div>
</template>

<style scoped>
/* ── Connectors ── */
.arch-connector {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 0;
	padding: 4px 0;
	opacity: 0;
	transition: opacity var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.15s + 0.1s);
}

.is-visible .arch-connector {
	opacity: 1;
}

.arch-connector-line {
	width: 2px;
	height: 16px;
	background: var(--color-border-strong);
	border-radius: 1px;
	position: relative;
}

.is-visible .arch-connector-line {
	animation: line-draw 0.6s var(--ease-spring) both;
	animation-delay: calc(var(--stagger) * 0.15s + 0.3s);
}

@keyframes line-draw {
	from {
		transform: scaleY(0);
	}
	to {
		transform: scaleY(1);
	}
}

.arch-connector-labels {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 2px;
	padding: 4px 14px;
	background: var(--color-bg-surface);
	border-radius: 6px;
	border: 1px solid var(--color-border-subtle);
}

.arch-connector-labels span {
	font-size: 0.6875rem;
	color: var(--color-text-secondary);
	font-family: var(--font-mono);
	white-space: nowrap;
}

.arch-connector-fork {
	display: flex;
	flex-direction: column;
	align-items: center;
	width: 80%;
	max-width: 400px;
}

.arch-fork-bar {
	width: 100%;
	height: 2px;
	background: var(--color-border-strong);
	border-radius: 1px;
}

.arch-fork-branches {
	display: flex;
	justify-content: space-between;
	width: 100%;
}

.arch-fork-line {
	width: 2px;
	height: 12px;
	background: var(--color-border-strong);
	border-radius: 1px;
}
</style>
