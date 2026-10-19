<script setup lang="ts">
import { Loader2, AlertTriangle } from '@lucide/vue';

// Stands in for a lazily loaded preview panel (see lazyPanels.ts) while its
// chunk loads, or once it has failed to; only a page reload fetches it again.
withDefaults(
	defineProps<{
		label: string;
		failed?: boolean;
		/** Which edge of the preview the panel docks to; picks the divider side. */
		placement?: 'top' | 'bottom';
	}>(),
	{ failed: false, placement: 'top' }
);

function reloadPage() {
	window.location.reload();
}
</script>

<template>
	<div
		class="ep-panel-loading"
		:class="`ep-panel-loading-${placement}`"
		:role="failed ? 'alert' : 'status'"
	>
		<AlertTriangle v-if="failed" class="ep-panel-loading-icon" />
		<Loader2 v-else class="ep-panel-loading-icon ep-panel-loading-spinner" />
		<template v-if="failed">
			<span>Couldn't load {{ label }}. Reload the page to try again.</span>
			<button type="button" class="ep-panel-loading-reload" @click="reloadPage">Reload</button>
		</template>
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

.ep-panel-loading-reload {
	margin-left: auto;
	padding: 4px 10px;
	border: 1px solid var(--ep-border-subtle);
	border-radius: 6px;
	background: var(--ep-bg-surface);
	color: var(--ep-text-primary);
	font-size: 12px;
	cursor: pointer;
}

.ep-panel-loading-reload:hover {
	background: var(--ep-bg-elevated);
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
