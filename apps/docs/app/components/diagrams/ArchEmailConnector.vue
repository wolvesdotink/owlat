<script setup lang="ts">
/**
 * The arrow connector between two sections of `ArchEmail`.
 *
 * The entrance rules key off the parent's `.is-visible`; scoped CSS only
 * scopes the last selector part, so that ancestor class still matches.
 */
defineProps<{
	/** Section step; drives the entrance stagger. */
	s: number;
}>();
</script>

<template>
	<div class="email-connector" :style="{ '--s': s }">
		<div class="email-connector-line" />
		<div class="email-connector-badge">
			<svg
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="M19 14l-7 7m0 0l-7-7m7 7V3" />
			</svg>
		</div>
		<div class="email-connector-line" />
	</div>
</template>

<style scoped>
/* ── Connectors ── */
.email-connector {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 0;
	padding: 2px 0;
	opacity: 0;
	transition: opacity var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--s) * 0.12s + 0.1s);
}

.is-visible .email-connector {
	opacity: 1;
}

.email-connector-line {
	width: 2px;
	height: 10px;
	background: var(--color-border-strong);
	border-radius: 1px;
}

.email-connector-badge {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 24px;
	height: 24px;
	border-radius: 50%;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-default);
	color: var(--color-text-tertiary);
	animation: connector-pulse 3s ease-in-out infinite;
}

@keyframes connector-pulse {
	0%,
	100% {
		box-shadow: 0 0 0 0 rgba(196, 120, 90, 0);
	}
	50% {
		box-shadow: 0 0 8px 2px rgba(196, 120, 90, 0.1);
	}
}
</style>
