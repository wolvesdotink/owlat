<script setup lang="ts">
import { Loader2, AlertTriangle } from '@lucide/vue';

// Stands in for a lazily loaded preview panel (see lazyPanels.ts) while its
// chunk loads, or if it fails to.
withDefaults(
	defineProps<{
		label: string;
		/** How to get the panel after a failed load. */
		retryHint: string;
		failed?: boolean;
		/** Which edge of the preview the panel docks to; picks the divider side. */
		placement?: 'top' | 'bottom';
	}>(),
	{ failed: false, placement: 'top' }
);
</script>

<template>
	<div
		class="ep-panel-loading"
		:class="`ep-panel-loading-${placement}`"
		:role="failed ? 'alert' : 'status'"
	>
		<AlertTriangle v-if="failed" class="ep-panel-loading-icon" />
		<Loader2 v-else class="ep-panel-loading-icon ep-panel-loading-spinner" />
		<span v-if="failed">Couldn't load {{ label }}. {{ retryHint }}</span>
		<span v-else>Loading {{ label }}…</span>
	</div>
</template>

<style scoped>
.ep-panel-loading {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 10px 16px;
	background: var(--ep-bg-surface);
	font-size: 12px;
	color: var(--ep-text-tertiary);
}

.ep-panel-loading-top {
	border-bottom: 1px solid var(--ep-border-subtle);
}

.ep-panel-loading-bottom {
	border-top: 1px solid var(--ep-border-subtle);
}

.ep-panel-loading-icon {
	width: 14px;
	height: 14px;
	flex-shrink: 0;
}

.ep-panel-loading-spinner {
	animation: ep-panel-loading-spin 1s linear infinite;
}

@keyframes ep-panel-loading-spin {
	to {
		transform: rotate(360deg);
	}
}
</style>
