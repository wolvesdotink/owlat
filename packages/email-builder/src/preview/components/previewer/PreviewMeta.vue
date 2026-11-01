<script setup lang="ts">
import { useBuilderI18n } from '../../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

defineProps<{
	subject: string;
	preheader: string;
}>();
</script>

<template>
	<div class="ep-meta-preview">
		<div v-if="subject" class="ep-meta-item">
			<span class="ep-meta-label">{{ t('builder.preview.meta.subject') }}</span>
			<span class="ep-meta-value">{{ subject }}</span>
		</div>
		<div v-if="preheader" class="ep-meta-item">
			<span class="ep-meta-label">{{ t('builder.preview.meta.preheader') }}</span>
			<span class="ep-meta-value ep-meta-preheader">{{ preheader }}</span>
		</div>
	</div>
</template>

<style scoped>
/* Meta Preview */
.ep-meta-preview {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 12px 16px;
	background: var(--ep-bg-elevated);
	border-top: 1px solid var(--ep-border-subtle);
}

.ep-meta-item {
	display: flex;
	align-items: baseline;
	gap: 12px;
}

.ep-meta-label {
	flex-shrink: 0;
	font-size: 11px;
	font-weight: 600;
	color: var(--ep-text-tertiary);
	text-transform: uppercase;
	letter-spacing: 0.05em;
}

.ep-meta-value {
	font-size: 13px;
	color: var(--ep-text-primary);
}

.ep-meta-preheader {
	color: var(--ep-text-secondary);
	font-style: italic;
}
</style>
