<script setup lang="ts">
import { computed } from 'vue';
import { AlertTriangle } from '@lucide/vue';
import { GMAIL_CLIP_BYTES } from '@owlat/shared/emailLimits';
import type { PreviewEmailAnalysis } from '../../types';
import AnalysisEmpty from './AnalysisEmpty.vue';

const props = defineProps<{
	emailAnalysis: PreviewEmailAnalysis | null;
}>();

const sizePercentage = computed(() => {
	if (!props.emailAnalysis) return 0;
	return Math.min(100, (props.emailAnalysis.htmlSizeBytes / GMAIL_CLIP_BYTES) * 100);
});

const formattedSize = computed(() => {
	if (!props.emailAnalysis) return '0 KB';
	const kb = props.emailAnalysis.htmlSizeBytes / 1024;
	return `${kb.toFixed(1)} KB`;
});

const sizeBreakdownBars = computed(() => {
	if (!props.emailAnalysis?.sizeBreakdown) return [];
	const bd = props.emailAnalysis.sizeBreakdown;
	const total = bd.totalBytes || 1;
	return [
		{ label: 'Styles', bytes: bd.styleBlockBytes, pct: (bd.styleBlockBytes / total) * 100, color: 'var(--ep-brand)' },
		{ label: 'VML', bytes: bd.msoConditionalBytes, pct: (bd.msoConditionalBytes / total) * 100, color: 'var(--ep-warning)' },
		{ label: 'Images', bytes: bd.imageTagBytes, pct: (bd.imageTagBytes / total) * 100, color: 'var(--ep-success)' },
		{ label: 'Text', bytes: bd.textContentBytes, pct: (bd.textContentBytes / total) * 100, color: 'var(--ep-text-secondary)' },
		{ label: 'Whitespace', bytes: bd.whitespaceBytes, pct: (bd.whitespaceBytes / total) * 100, color: 'var(--ep-text-tertiary)' },
		{ label: 'Markup', bytes: bd.markupOverheadBytes, pct: (bd.markupOverheadBytes / total) * 100, color: 'var(--ep-error)' },
	].filter((b) => b.bytes > 0);
});

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}
</script>

<template>
	<template v-if="emailAnalysis">
		<!-- Total size vs Gmail threshold -->
		<div class="ep-size-total">
			<div class="ep-size-total-header">
				<span>Total Size</span>
				<span :class="{ 'ep-size-danger': emailAnalysis.exceedsGmailClip }">
					{{ formattedSize }} / 102 KB
				</span>
			</div>
			<div class="ep-size-bar-track">
				<div
					class="ep-size-bar-fill"
					:class="{ 'ep-size-bar-danger': emailAnalysis.exceedsGmailClip }"
					:style="{ width: `${sizePercentage}%` }"
				></div>
			</div>
			<div v-if="emailAnalysis.exceedsGmailClip" class="ep-size-warning">
				<AlertTriangle class="ep-size-warning-icon" />
				Gmail will clip this email.
			</div>
		</div>

		<!-- CSS size warning -->
		<div v-if="emailAnalysis.exceedsGmailCssLimit" class="ep-size-css-warning">
			<AlertTriangle class="ep-size-warning-icon" />
			CSS exceeds 8KB — Gmail may strip styles.
			<span v-if="emailAnalysis.styleBlockSizeBytes" class="ep-size-css-value">
				({{ formatBytes(emailAnalysis.styleBlockSizeBytes) }})
			</span>
		</div>

		<!-- Breakdown bars -->
		<div v-if="sizeBreakdownBars.length > 0" class="ep-size-breakdown">
			<div class="ep-size-breakdown-title">Size Breakdown</div>
			<div v-for="bar in sizeBreakdownBars" :key="bar.label" class="ep-size-breakdown-item">
				<div class="ep-size-breakdown-label">
					<span>{{ bar.label }}</span>
					<span class="ep-size-breakdown-value">{{ formatBytes(bar.bytes) }}</span>
				</div>
				<div class="ep-size-breakdown-track">
					<div
						class="ep-size-breakdown-fill"
						:style="{ width: `${bar.pct}%`, background: bar.color }"
					></div>
				</div>
			</div>
		</div>

		<!-- Quick stats -->
		<div class="ep-size-stats">
			<div class="ep-size-stat">
				<span class="ep-size-stat-label">Images</span>
				<span class="ep-size-stat-value">{{ emailAnalysis.imageCount }}</span>
			</div>
			<div class="ep-size-stat">
				<span class="ep-size-stat-label">Links</span>
				<span class="ep-size-stat-value">{{ emailAnalysis.linkCount }}</span>
			</div>
			<div class="ep-size-stat">
				<span class="ep-size-stat-label">Text:Image</span>
				<span class="ep-size-stat-value">{{ emailAnalysis.textToImageRatio.toFixed(1) }}</span>
			</div>
			<div class="ep-size-stat">
				<span class="ep-size-stat-label">Table Depth</span>
				<span class="ep-size-stat-value">{{ emailAnalysis.tableNestingDepth }}</span>
			</div>
		</div>

		<!-- Optimization suggestions -->
		<div v-if="emailAnalysis.optimizations?.length" class="ep-size-optimizations">
			<div class="ep-size-optimizations-title">Optimization Suggestions</div>
			<div
				v-for="(opt, idx) in emailAnalysis.optimizations"
				:key="idx"
				class="ep-size-optimization"
			>
				<span class="ep-size-opt-desc">{{ opt.description }}</span>
				<span class="ep-size-opt-savings">~{{ formatBytes(opt.estimatedSavings) }}</span>
			</div>
		</div>
	</template>
	<AnalysisEmpty v-else>No size analysis data available.</AnalysisEmpty>
</template>

<style scoped>
.ep-size-total {
	margin-bottom: 16px;
}

.ep-size-total-header {
	display: flex;
	justify-content: space-between;
	font-size: 12px;
	color: var(--ep-text-secondary);
	margin-bottom: 6px;
}

.ep-size-danger {
	color: var(--ep-error);
	font-weight: 600;
}

.ep-size-bar-track {
	height: 6px;
	background: var(--ep-bg-overlay);
	border-radius: 3px;
}

.ep-size-bar-fill {
	height: 100%;
	border-radius: 3px;
	background: var(--ep-success);
	transition: width var(--motion-moderate, 160ms) var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-size-bar-danger {
	background: var(--ep-error);
}

.ep-size-warning,
.ep-size-css-warning {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-top: 8px;
	padding: 6px 8px;
	border-radius: 6px;
	background: var(--ep-error-subtle);
	color: var(--ep-error);
	font-size: 11px;
}

.ep-size-css-warning {
	background: var(--ep-warning-subtle);
	color: var(--ep-warning);
	margin-bottom: 12px;
}

.ep-size-warning-icon {
	width: 12px;
	height: 12px;
	flex-shrink: 0;
}

.ep-size-css-value {
	color: var(--ep-text-tertiary);
}

.ep-size-breakdown {
	margin-bottom: 16px;
}

.ep-size-breakdown-title,
.ep-size-optimizations-title {
	font-size: 11px;
	font-weight: 600;
	color: var(--ep-text-tertiary);
	text-transform: uppercase;
	letter-spacing: 0.05em;
	margin-bottom: 8px;
}

.ep-size-breakdown-item {
	margin-bottom: 6px;
}

.ep-size-breakdown-label {
	display: flex;
	justify-content: space-between;
	font-size: 11px;
	color: var(--ep-text-secondary);
	margin-bottom: 3px;
}

.ep-size-breakdown-value {
	color: var(--ep-text-tertiary);
}

.ep-size-breakdown-track {
	height: 3px;
	background: var(--ep-bg-overlay);
	border-radius: 2px;
}

.ep-size-breakdown-fill {
	height: 100%;
	border-radius: 2px;
	transition: width var(--motion-moderate, 160ms) var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-size-stats {
	display: grid;
	grid-template-columns: repeat(4, 1fr);
	gap: 8px;
	margin-bottom: 16px;
}

.ep-size-stat {
	display: flex;
	flex-direction: column;
	align-items: center;
	padding: 8px;
	background: var(--ep-bg-elevated);
	border-radius: 6px;
}

.ep-size-stat-label {
	font-size: 10px;
	color: var(--ep-text-tertiary);
	text-transform: uppercase;
}

.ep-size-stat-value {
	font-size: 16px;
	font-weight: 600;
	color: var(--ep-text-primary);
}

.ep-size-optimization {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 6px 0;
	font-size: 12px;
	border-bottom: 1px solid var(--ep-border-subtle);
}

.ep-size-optimization:last-child {
	border-bottom: none;
}

.ep-size-opt-desc {
	color: var(--ep-text-secondary);
}

.ep-size-opt-savings {
	color: var(--ep-success);
	font-weight: 500;
	flex-shrink: 0;
}
</style>
