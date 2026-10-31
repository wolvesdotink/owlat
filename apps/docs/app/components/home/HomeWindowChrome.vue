<script setup lang="ts">
/**
 * Editor-window title bar shared by the home page's code cards: three dots,
 * a file-name pill, and the default slot for controls on the right (the code
 * preview's language tabs).
 */
defineProps<{
	file: string;
	/** Hide the pill on narrow screens, where the controls need the room. */
	centered?: boolean;
}>();
</script>

<template>
	<div class="window-chrome">
		<div class="chrome-dots">
			<span v-for="i in 3" :key="i" class="dot" />
		</div>
		<span class="chrome-pill" :class="{ 'chrome-pill-center': centered }">{{ file }}</span>
		<slot />
	</div>
</template>

<style scoped>
/* ── Window chrome (shared by snippet + code window) ── */
.window-chrome {
	position: relative;
	display: flex;
	align-items: center;
	padding: 10px 14px;
	border-bottom: 1px solid var(--color-border-subtle);
	background: var(--surface-1);
}

.chrome-dots {
	display: flex;
	gap: 6px;
}

.dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: var(--color-border-strong);
}

.chrome-pill {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	position: absolute;
	left: 50%;
	transform: translateX(-50%);
	padding: 2px 12px;
	border: 1px solid var(--color-border-subtle);
	border-radius: 9999px;
	background: var(--surface-3);
	font-family: var(--font-mono);
	font-size: 10px;
	color: var(--color-text-tertiary);
	white-space: nowrap;
}

@media (max-width: 580px) {
	.chrome-pill-center {
		display: none;
	}
}
</style>
