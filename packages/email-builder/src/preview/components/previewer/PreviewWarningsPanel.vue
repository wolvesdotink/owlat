<script setup lang="ts">
import { AlertTriangle, X } from '@lucide/vue';
import { useBuilderI18n } from '../../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

defineProps<{
	renderWarnings: string[];
}>();

const emit = defineEmits<{
	(e: 'close'): void;
}>();
</script>

<template>
	<div class="ep-warnings-panel">
		<div class="ep-warnings-header">
			<span class="ep-warnings-title">
				<AlertTriangle class="ep-warnings-title-icon" />
				{{ t('builder.preview.warnings.title', { count: renderWarnings.length }) }}
			</span>
			<button class="ep-warnings-close" @click="emit('close')">
				<X class="ep-warnings-close-icon" />
			</button>
		</div>
		<ul class="ep-warnings-list">
			<li v-for="(warning, idx) in renderWarnings" :key="idx" class="ep-warnings-item">
				{{ warning }}
			</li>
		</ul>
	</div>
</template>

<style scoped>
/* Warnings Panel */
.ep-warnings-panel {
	background: var(--ep-warning-subtle);
	border-bottom: 1px solid var(--ep-border-subtle);
	padding: 12px 16px;
}

.ep-warnings-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	margin-bottom: 8px;
}

.ep-warnings-title {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 12px;
	font-weight: 600;
	color: var(--ep-warning);
}

.ep-warnings-title-icon {
	width: 14px;
	height: 14px;
}

.ep-warnings-close {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 24px;
	height: 24px;
	background: transparent;
	border: none;
	border-radius: 4px;
	color: var(--ep-text-tertiary);
	cursor: pointer;
}

.ep-warnings-close:hover {
	background: var(--ep-bg-surface);
	color: var(--ep-text-primary);
}

.ep-warnings-close-icon {
	width: 14px;
	height: 14px;
}

.ep-warnings-list {
	margin: 0;
	padding: 0 0 0 20px;
	list-style: disc;
}

.ep-warnings-item {
	font-size: 12px;
	line-height: 1.5;
	color: var(--ep-text-secondary);
	padding: 2px 0;
}
</style>
