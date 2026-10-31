<script setup lang="ts">
/**
 * The connector between two sections of `EmailArchitecture`, badged with the
 * format that crosses it.
 *
 * The entrance rules key off the parent's `.is-visible`; scoped CSS only
 * scopes the last selector part, so that ancestor class still matches.
 */
defineProps<{
	/** Section step; drives the entrance stagger. */
	s: number;
	label: string;
}>();
</script>

<template>
	<div class="ea-connector" :style="{ '--s': s }">
		<div class="ea-connector-line" />
		<div class="ea-connector-badge">
			<span>{{ label }}</span>
		</div>
		<div class="ea-connector-line" />
	</div>
</template>

<style scoped>
/* Connectors */
.ea-connector {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 0;
	padding: 2px 0;
	opacity: 0;
	transition: opacity var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--s) * 0.12s + 0.1s);
}

.is-visible .ea-connector {
	opacity: 1;
}

.ea-connector-line {
	width: 2px;
	height: 10px;
	background: var(--color-border-strong);
	border-radius: 1px;
}

.ea-connector-badge {
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 2px 10px;
	border-radius: 9999px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-default);
	animation: ea-badge-pulse 3s ease-in-out infinite;
}

.ea-connector-badge span {
	font-size: 0.625rem;
	font-family: var(--font-mono);
	font-weight: var(--font-weight-semibold);
	color: var(--color-text-tertiary);
	text-transform: uppercase;
	letter-spacing: 0.05em;
}

@keyframes ea-badge-pulse {
	0%,
	100% {
		box-shadow: 0 0 0 0 rgba(196, 120, 90, 0);
	}
	50% {
		box-shadow: 0 0 8px 2px rgba(196, 120, 90, 0.1);
	}
}
</style>
