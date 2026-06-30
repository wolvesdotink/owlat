<script setup lang="ts">
import { computed } from 'vue';
import {
	X,
	Plus,
	Minus,
	Pencil,
	FileText,
	Image,
	Link,
	Palette,
	Layout,
	Tag,
} from '@lucide/vue';
import type { PreviewEmailDiff, PreviewEmailDiffChange } from '../types';

const props = defineProps<{
	emailDiff: PreviewEmailDiff;
}>();

const emit = defineEmits<{
	(e: 'close'): void;
}>();

const totalChanges = computed(() => {
	return props.emailDiff.changes.length;
});

const sizeDeltaFormatted = computed(() => {
	const delta = props.emailDiff.sizeDelta;
	const abs = Math.abs(delta);
	const formatted = abs < 1024 ? `${abs} B` : `${(abs / 1024).toFixed(1)} KB`;
	return delta > 0 ? `+${formatted}` : delta < 0 ? `-${formatted}` : '0 B';
});

const sizeDeltaColor = computed(() => {
	if (props.emailDiff.sizeDelta > 0) return 'var(--ep-error)';
	if (props.emailDiff.sizeDelta < 0) return 'var(--ep-success)';
	return 'var(--ep-text-tertiary)';
});

function getCategoryIcon(category: PreviewEmailDiffChange['category']) {
	switch (category) {
		case 'text': return FileText;
		case 'style': return Palette;
		case 'image': return Image;
		case 'link': return Link;
		case 'structure': return Layout;
		case 'meta': return Tag;
		default: return FileText;
	}
}

function getTypeIcon(type: PreviewEmailDiffChange['type']) {
	switch (type) {
		case 'added': return Plus;
		case 'removed': return Minus;
		case 'modified': return Pencil;
		default: return Pencil;
	}
}
</script>

<template>
	<div class="ep-diff-panel">
		<div class="ep-diff-header">
			<span class="ep-diff-title">Changes</span>
			<div class="ep-diff-stats">
				<span class="ep-diff-stat ep-diff-added">+{{ emailDiff.stats.addedElements }}</span>
				<span class="ep-diff-stat ep-diff-removed">-{{ emailDiff.stats.removedElements }}</span>
				<span class="ep-diff-stat ep-diff-modified">~{{ emailDiff.stats.modifiedStyles }}</span>
				<span class="ep-diff-stat ep-diff-size" :style="{ color: sizeDeltaColor }">
					{{ sizeDeltaFormatted }}
				</span>
			</div>
			<button class="ep-diff-close" @click="emit('close')">
				<X class="ep-diff-close-icon" />
			</button>
		</div>

		<div class="ep-diff-body">
			<div v-if="emailDiff.identical" class="ep-diff-identical">
				No changes detected.
			</div>
			<template v-else>
				<!-- Summary -->
				<div class="ep-diff-summary">
					{{ totalChanges }} change{{ totalChanges === 1 ? '' : 's' }} detected
				</div>

				<!-- Change list -->
				<div class="ep-diff-changes">
					<div
						v-for="(change, idx) in emailDiff.changes"
						:key="idx"
						class="ep-diff-change"
						:class="`ep-diff-change-${change.type}`"
					>
						<component :is="getTypeIcon(change.type)" class="ep-diff-change-type-icon" />
						<component :is="getCategoryIcon(change.category)" class="ep-diff-change-cat-icon" />
						<div class="ep-diff-change-content">
							<span class="ep-diff-change-desc">{{ change.description }}</span>
							<span v-if="change.context" class="ep-diff-change-context">{{ change.context }}</span>
						</div>
					</div>
				</div>
			</template>
		</div>
	</div>
</template>

<style scoped>
.ep-diff-panel {
	border-bottom: 1px solid var(--ep-border-subtle);
	background: var(--ep-bg-elevated);
}

.ep-diff-header {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 10px 16px;
	border-bottom: 1px solid var(--ep-border-subtle);
}

.ep-diff-title {
	font-size: 12px;
	font-weight: 600;
	color: var(--ep-text-primary);
}

.ep-diff-stats {
	display: flex;
	gap: 8px;
	flex: 1;
}

.ep-diff-stat {
	font-size: 11px;
	font-weight: 600;
	font-family: var(--ep-font-mono);
}

.ep-diff-added {
	color: var(--ep-success);
}

.ep-diff-removed {
	color: var(--ep-error);
}

.ep-diff-modified {
	color: var(--ep-warning);
}

.ep-diff-close {
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
	margin-left: auto;
}

.ep-diff-close:hover {
	background: var(--ep-bg-surface);
	color: var(--ep-text-primary);
}

.ep-diff-close-icon {
	width: 14px;
	height: 14px;
}

.ep-diff-body {
	padding: 12px 16px;
	max-height: 250px;
	overflow-y: auto;
}

.ep-diff-identical {
	font-size: 12px;
	color: var(--ep-text-tertiary);
	padding: 8px 0;
}

.ep-diff-summary {
	font-size: 12px;
	color: var(--ep-text-secondary);
	margin-bottom: 8px;
}

.ep-diff-changes {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.ep-diff-change {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	padding: 6px 8px;
	border-radius: 6px;
	background: var(--ep-bg-surface);
}

.ep-diff-change-added {
	border-left: 2px solid var(--ep-success);
}

.ep-diff-change-removed {
	border-left: 2px solid var(--ep-error);
}

.ep-diff-change-modified {
	border-left: 2px solid var(--ep-warning);
}

.ep-diff-change-type-icon {
	width: 12px;
	height: 12px;
	flex-shrink: 0;
	margin-top: 2px;
}

.ep-diff-change-added .ep-diff-change-type-icon {
	color: var(--ep-success);
}

.ep-diff-change-removed .ep-diff-change-type-icon {
	color: var(--ep-error);
}

.ep-diff-change-modified .ep-diff-change-type-icon {
	color: var(--ep-warning);
}

.ep-diff-change-cat-icon {
	width: 12px;
	height: 12px;
	flex-shrink: 0;
	margin-top: 2px;
	color: var(--ep-text-tertiary);
}

.ep-diff-change-content {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}

.ep-diff-change-desc {
	font-size: 12px;
	color: var(--ep-text-secondary);
	line-height: 1.4;
}

.ep-diff-change-context {
	font-size: 10px;
	font-family: var(--ep-font-mono);
	color: var(--ep-text-tertiary);
}
</style>
