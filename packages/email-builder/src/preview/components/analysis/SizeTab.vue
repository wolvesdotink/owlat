<script setup lang="ts">
import { computed } from 'vue';
import { TriangleWarningIcon } from '@coolicons/vue';
import { GMAIL_CLIP_BYTES } from '@owlat/shared/emailLimits';
import type { PreviewEmailAnalysis } from '../../types';
import AnalysisEmpty from './AnalysisEmpty.vue';
import { meterFillStyle } from '@owlat/ui/utils/meterFill';
import { useBuilderI18n } from '../../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

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
		{
			id: 'styles',
			label: t('builder.analysis.size.breakdown.styles'),
			bytes: bd.styleBlockBytes,
			pct: (bd.styleBlockBytes / total) * 100,
			color: 'var(--ep-brand)',
		},
		{
			id: 'vml',
			label: t('builder.analysis.size.breakdown.vml'),
			bytes: bd.msoConditionalBytes,
			pct: (bd.msoConditionalBytes / total) * 100,
			color: 'var(--ep-warning)',
		},
		{
			id: 'images',
			label: t('builder.analysis.size.breakdown.images'),
			bytes: bd.imageTagBytes,
			pct: (bd.imageTagBytes / total) * 100,
			color: 'var(--ep-success)',
		},
		{
			id: 'text',
			label: t('builder.analysis.size.breakdown.text'),
			bytes: bd.textContentBytes,
			pct: (bd.textContentBytes / total) * 100,
			color: 'var(--ep-text-secondary)',
		},
		{
			id: 'whitespace',
			label: t('builder.analysis.size.breakdown.whitespace'),
			bytes: bd.whitespaceBytes,
			pct: (bd.whitespaceBytes / total) * 100,
			color: 'var(--ep-text-tertiary)',
		},
		{
			id: 'markup',
			label: t('builder.analysis.size.breakdown.markup'),
			bytes: bd.markupOverheadBytes,
			pct: (bd.markupOverheadBytes / total) * 100,
			color: 'var(--ep-error)',
		},
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
				<span>{{ t('builder.analysis.size.total') }}</span>
				<span :class="{ 'ep-size-danger': emailAnalysis.exceedsGmailClip }">
					{{ formattedSize }} / 102 KB
				</span>
			</div>
			<div class="ep-size-bar-track">
				<div
					class="ep-size-bar-fill"
					:class="{ 'ep-size-bar-danger': emailAnalysis.exceedsGmailClip }"
					:style="meterFillStyle(sizePercentage)"
				></div>
			</div>
			<div v-if="emailAnalysis.exceedsGmailClip" class="ep-size-warning">
				<TriangleWarningIcon class="ep-size-warning-icon" />
				{{ t('builder.analysis.size.gmailClip') }}
			</div>
		</div>

		<!-- CSS size warning -->
		<div v-if="emailAnalysis.exceedsGmailCssLimit" class="ep-size-css-warning">
			<TriangleWarningIcon class="ep-size-warning-icon" />
			{{ t('builder.analysis.size.cssLimit') }}
			<span v-if="emailAnalysis.styleBlockSizeBytes" class="ep-size-css-value">
				({{ formatBytes(emailAnalysis.styleBlockSizeBytes) }})
			</span>
		</div>

		<!-- Breakdown bars -->
		<div v-if="sizeBreakdownBars.length > 0" class="ep-size-breakdown">
			<div class="ep-size-breakdown-title">{{ t('builder.analysis.size.breakdownTitle') }}</div>
			<div v-for="bar in sizeBreakdownBars" :key="bar.id" class="ep-size-breakdown-item">
				<div class="ep-size-breakdown-label">
					<span>{{ bar.label }}</span>
					<span class="ep-size-breakdown-value">{{ formatBytes(bar.bytes) }}</span>
				</div>
				<div class="ep-size-breakdown-track">
					<div
						class="ep-size-breakdown-fill"
						:style="[meterFillStyle(bar.pct), { background: bar.color }]"
					></div>
				</div>
			</div>
		</div>

		<!-- Quick stats -->
		<div class="ep-size-stats">
			<div class="ep-size-stat">
				<span class="ep-size-stat-label">{{ t('builder.analysis.size.images') }}</span>
				<span class="ep-size-stat-value">{{ emailAnalysis.imageCount }}</span>
			</div>
			<div class="ep-size-stat">
				<span class="ep-size-stat-label">{{ t('builder.analysis.size.links') }}</span>
				<span class="ep-size-stat-value">{{ emailAnalysis.linkCount }}</span>
			</div>
			<div class="ep-size-stat">
				<span class="ep-size-stat-label">{{ t('builder.analysis.size.textToImage') }}</span>
				<span class="ep-size-stat-value">{{ emailAnalysis.textToImageRatio.toFixed(1) }}</span>
			</div>
			<div class="ep-size-stat">
				<span class="ep-size-stat-label">{{ t('builder.analysis.size.tableDepth') }}</span>
				<span class="ep-size-stat-value">{{ emailAnalysis.tableNestingDepth }}</span>
			</div>
		</div>

		<!-- Optimization suggestions -->
		<div v-if="emailAnalysis.optimizations?.length" class="ep-size-optimizations">
			<div class="ep-size-optimizations-title">
				{{ t('builder.analysis.size.optimizations') }}
			</div>
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
	<AnalysisEmpty v-else>{{ t('builder.analysis.size.empty') }}</AnalysisEmpty>
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
	overflow: hidden;
}

/* Full-width fills slid in from the left (the `.ui-meter-fill` recipe): a new
 * analysis moves composited layers instead of re-laying-out the panel. */
.ep-size-bar-fill,
.ep-size-breakdown-fill {
	height: 100%;
	width: 100%;
	transform: translateX(calc(var(--ui-meter-value, 0) * 1% - 100%));
	transition: transform var(--motion-moderate, 160ms)
		var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-size-bar-fill {
	border-radius: 3px;
	background: var(--ep-success);
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
	overflow: hidden;
}

.ep-size-breakdown-fill {
	border-radius: 2px;
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
