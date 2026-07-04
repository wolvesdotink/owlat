<script setup lang="ts">
import { ref, computed } from 'vue';
import { ChevronDown, BarChart3, Loader2 } from '@lucide/vue';
import type {
	CompatibilityReport,
	NestingDepthResult,
	PreviewEmailAnalysis,
	PreviewHealthScore,
	PreviewValidationIssue,
} from '../types';
import HealthTab from './analysis/HealthTab.vue';
import SizeTab from './analysis/SizeTab.vue';
import ValidationTab from './analysis/ValidationTab.vue';
import CompatibilityTab from './analysis/CompatibilityTab.vue';

const props = defineProps<{
	emailAnalysis: PreviewEmailAnalysis | null;
	healthScore: PreviewHealthScore | null;
	validationIssues: PreviewValidationIssue[];
	compatibilityReport: CompatibilityReport | null;
	nestingDepthWarning?: NestingDepthResult | null;
	isAnalyzing?: boolean;
	expanded?: boolean;
}>();

const emit = defineEmits<{
	(e: 'toggle'): void;
}>();

const activeTab = ref<'health' | 'size' | 'validation' | 'compatibility'>('health');

// Error count drives the badge on the Validation tab.
const errorCount = computed(() => props.validationIssues.filter((i) => i.severity === 'error').length);

// Summary for the collapsed header.
const headerSummary = computed(() => {
	if (props.healthScore) {
		return `Score: ${Math.round(props.healthScore.overall)}/100`;
	}
	if (props.emailAnalysis) {
		return `${(props.emailAnalysis.htmlSizeBytes / 1024).toFixed(1)} KB`;
	}
	return 'Analysis';
});
</script>

<template>
	<div class="ep-analysis-panel">
		<!-- Collapsible Header -->
		<button class="ep-analysis-header" @click="emit('toggle')">
			<div class="ep-analysis-header-left">
				<BarChart3 class="ep-analysis-header-icon" />
				<span class="ep-analysis-header-title">Analysis</span>
				<span class="ep-analysis-header-summary">{{ headerSummary }}</span>
				<Loader2 v-if="isAnalyzing" class="ep-analysis-spinner" />
			</div>
			<ChevronDown class="ep-analysis-chevron" :class="{ 'ep-analysis-chevron-open': expanded }" />
		</button>

		<!-- Expanded Content -->
		<div v-if="expanded" class="ep-analysis-body">
			<!-- Tabs -->
			<div class="ep-analysis-tabs">
				<button
					class="ep-analysis-tab"
					:class="{ 'ep-analysis-tab-active': activeTab === 'health' }"
					@click="activeTab = 'health'"
				>
					Health
				</button>
				<button
					class="ep-analysis-tab"
					:class="{ 'ep-analysis-tab-active': activeTab === 'size' }"
					@click="activeTab = 'size'"
				>
					Size
				</button>
				<button
					class="ep-analysis-tab"
					:class="{ 'ep-analysis-tab-active': activeTab === 'validation' }"
					@click="activeTab = 'validation'"
				>
					Validation
					<span v-if="errorCount > 0" class="ep-analysis-tab-badge ep-badge-error">{{ errorCount }}</span>
				</button>
				<button
					class="ep-analysis-tab"
					:class="{ 'ep-analysis-tab-active': activeTab === 'compatibility' }"
					@click="activeTab = 'compatibility'"
				>
					Compatibility
				</button>
			</div>

			<!-- Tab Content -->
			<div class="ep-analysis-tab-content">
				<div class="ep-analysis-section">
					<HealthTab v-if="activeTab === 'health'" :health-score="healthScore" />
					<SizeTab v-else-if="activeTab === 'size'" :email-analysis="emailAnalysis" />
					<ValidationTab v-else-if="activeTab === 'validation'" :validation-issues="validationIssues" />
					<CompatibilityTab
						v-else
						:compatibility-report="compatibilityReport"
						:nesting-depth-warning="nestingDepthWarning"
					/>
				</div>
			</div>
		</div>
	</div>
</template>

<style scoped>
.ep-analysis-panel {
	border-top: 1px solid var(--ep-border-subtle);
	background: var(--ep-bg-surface);
}

/* Header */
.ep-analysis-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	width: 100%;
	padding: 10px 16px;
	background: transparent;
	border: none;
	cursor: pointer;
	transition: background var(--motion-fast, 80ms) var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-analysis-header:hover {
	background: var(--ep-bg-surface-hover);
}

.ep-analysis-header-left {
	display: flex;
	align-items: center;
	gap: 8px;
}

.ep-analysis-header-icon {
	width: 14px;
	height: 14px;
	color: var(--ep-text-tertiary);
}

.ep-analysis-header-title {
	font-size: 12px;
	font-weight: 600;
	color: var(--ep-text-primary);
}

.ep-analysis-header-summary {
	font-size: 12px;
	color: var(--ep-text-tertiary);
}

.ep-analysis-spinner {
	width: 12px;
	height: 12px;
	color: var(--ep-text-tertiary);
	animation: ep-spin 1s linear infinite;
}

.ep-analysis-chevron {
	width: 14px;
	height: 14px;
	color: var(--ep-text-tertiary);
	transition: transform var(--motion-moderate, 160ms) var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-analysis-chevron-open {
	transform: rotate(180deg);
}

/* Body */
.ep-analysis-body {
	border-top: 1px solid var(--ep-border-subtle);
}

/* Tabs */
.ep-analysis-tabs {
	display: flex;
	padding: 0 16px;
	gap: 0;
	border-bottom: 1px solid var(--ep-border-subtle);
}

.ep-analysis-tab {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 8px 12px;
	background: transparent;
	border: none;
	border-bottom: 2px solid transparent;
	color: var(--ep-text-tertiary);
	font-size: 12px;
	font-weight: 500;
	cursor: pointer;
	transition: all var(--motion-fast, 80ms) var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-analysis-tab:hover {
	color: var(--ep-text-secondary);
}

.ep-analysis-tab-active {
	color: var(--ep-text-primary);
	border-bottom-color: var(--ep-brand);
}

.ep-analysis-tab-badge {
	padding: 0 5px;
	border-radius: 8px;
	font-size: 10px;
	font-weight: 700;
	line-height: 16px;
}

.ep-badge-error {
	background: var(--ep-error-subtle);
	color: var(--ep-error);
}

/* Tab Content */
.ep-analysis-tab-content {
	max-height: 300px;
	overflow-y: auto;
}

.ep-analysis-section {
	padding: 12px 16px;
}

@keyframes ep-spin {
	from {
		transform: rotate(0deg);
	}
	to {
		transform: rotate(360deg);
	}
}
</style>
