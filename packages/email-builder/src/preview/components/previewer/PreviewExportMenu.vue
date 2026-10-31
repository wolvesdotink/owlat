<script setup lang="ts">
import { Download, Copy, Check } from '@lucide/vue';
import { useBuilderI18n } from '../../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

defineProps<{
	html: string;
	/** The plain text the Text view shows; empty when there is none. */
	plainText: string;
	ampHtml: string;
	/** The format copied last, while its confirmation shows. */
	copiedFormat: string | null;
}>();

const emit = defineEmits<{
	(e: 'copy', text: string, format: string): void;
	(e: 'download', content: string, filename: string, mimeType: string): void;
}>();
</script>

<template>
	<div class="ep-export-menu">
		<button class="ep-export-item" @click="emit('copy', html, 'html')">
			<Copy class="ep-export-item-icon" />
			<span>{{ t('builder.preview.export.copyHtml') }}</span>
			<Check v-if="copiedFormat === 'html'" class="ep-export-check" />
		</button>
		<button v-if="plainText" class="ep-export-item" @click="emit('copy', plainText, 'text')">
			<Copy class="ep-export-item-icon" />
			<span>{{ t('builder.preview.export.copyText') }}</span>
			<Check v-if="copiedFormat === 'text'" class="ep-export-check" />
		</button>
		<div class="ep-export-divider"></div>
		<button class="ep-export-item" @click="emit('download', html, 'email.html', 'text/html')">
			<Download class="ep-export-item-icon" />
			<span>{{ t('builder.preview.export.download', { file: '.html' }) }}</span>
		</button>
		<button
			v-if="plainText"
			class="ep-export-item"
			@click="emit('download', plainText, 'email.txt', 'text/plain')"
		>
			<Download class="ep-export-item-icon" />
			<span>{{ t('builder.preview.export.download', { file: '.txt' }) }}</span>
		</button>
		<button
			v-if="ampHtml"
			class="ep-export-item"
			@click="emit('download', ampHtml, 'email.amp.html', 'text/html')"
		>
			<Download class="ep-export-item-icon" />
			<span>{{ t('builder.preview.export.download', { file: '.amp.html' }) }}</span>
		</button>
	</div>
</template>

<style scoped>
.ep-export-menu {
	position: absolute;
	top: 100%;
	right: 0;
	margin-top: 4px;
	min-width: 200px;
	background: var(--ep-bg-elevated);
	border: 1px solid var(--ep-border-default);
	border-radius: 8px;
	box-shadow: var(--ep-shadow-lg);
	padding: 4px;
	z-index: 50;
}

.ep-export-item {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
	padding: 8px 12px;
	background: transparent;
	border: none;
	border-radius: 6px;
	color: var(--ep-text-secondary);
	font-size: 13px;
	cursor: pointer;
	transition-property: color, background-color;
	transition-duration: var(--motion-fast, 80ms);
	transition-timing-function: var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-export-item:hover {
	background: var(--ep-bg-surface);
	color: var(--ep-text-primary);
}

.ep-export-item-icon {
	width: 14px;
	height: 14px;
	flex-shrink: 0;
}

.ep-export-check {
	width: 14px;
	height: 14px;
	color: var(--ep-success);
	margin-left: auto;
}

.ep-export-divider {
	height: 1px;
	background: var(--ep-border-subtle);
	margin: 4px 0;
}
</style>
