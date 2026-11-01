<script setup lang="ts">
import { onMounted, useTemplateRef } from 'vue';
import { TriangleWarningIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';
import { useUiI18n } from '@owlat/ui/composables/useUiI18n';

// Stands in for a lazily loaded preview panel (see lazyPanels.ts) while its
// chunk loads, or once it has failed to. The copy is the UI layer's own
// localized loading/error/retry copy, so it follows the app's locale.
const props = withDefaults(
	defineProps<{
		failed?: boolean;
		/** Focus "Try again" on mount: this failure answers a retry. */
		focusRetry?: boolean;
		/** Which edge of the preview the panel docks to; picks the divider side. */
		placement?: 'top' | 'bottom';
	}>(),
	{ failed: false, focusRetry: false, placement: 'top' }
);

const emit = defineEmits<{
	(e: 'retry'): void;
}>();

const { t } = useUiI18n();

const retryButton = useTemplateRef<HTMLButtonElement>('retryButton');
onMounted(() => {
	if (props.focusRetry) retryButton.value?.focus();
});
</script>

<template>
	<div
		class="ep-panel-loading"
		:class="`ep-panel-loading-${placement}`"
		:role="failed ? 'alert' : 'status'"
	>
		<template v-if="failed">
			<TriangleWarningIcon class="ep-panel-loading-icon" aria-hidden="true" />
			<span>{{ t('ui.errorBoundary.message') }}</span>
			<button ref="retryButton" type="button" class="ep-panel-loading-retry" @click="emit('retry')">
				{{ t('ui.actions.retry') }}
			</button>
		</template>
		<template v-else>
			<SpinnerIcon class="ep-panel-loading-icon ep-panel-loading-spinner" aria-hidden="true" />
			<span>{{ t('ui.progress.loading') }}</span>
		</template>
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

.ep-panel-loading-retry {
	margin-left: auto;
	padding: 4px 10px;
	border: 1px solid var(--ep-border-subtle);
	border-radius: 6px;
	background: var(--ep-bg-surface);
	color: var(--ep-text-primary);
	font-size: 12px;
	cursor: pointer;
}

.ep-panel-loading-retry:hover {
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
