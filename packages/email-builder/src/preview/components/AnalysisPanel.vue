<script setup lang="ts">
import { ref, computed, useId } from 'vue';
import { ChartBarVerticalIcon, ChevronDownIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';
import type {
	CompatibilityReport,
	PreviewEmailAnalysis,
	PreviewHealthScore,
	PreviewValidationIssue,
} from '../types';
import HealthTab from './analysis/HealthTab.vue';
import SizeTab from './analysis/SizeTab.vue';
import ValidationTab from './analysis/ValidationTab.vue';
import CompatibilityTab from './analysis/CompatibilityTab.vue';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

const props = defineProps<{
	emailAnalysis: PreviewEmailAnalysis | null;
	healthScore: PreviewHealthScore | null;
	validationIssues: PreviewValidationIssue[];
	compatibilityReport: CompatibilityReport | null;
	/** Why the compatibility analysis failed, if it did. */
	compatibilityError?: string | null;
	/** The client the compatibility analysis is for; null when none is picked. */
	selectedClientName?: string | null;
	isAnalyzing?: boolean;
	expanded?: boolean;
}>();

const emit = defineEmits<{
	(e: 'toggle'): void;
}>();

type AnalysisTab = 'health' | 'size' | 'validation' | 'compatibility';
const activeTab = ref<AnalysisTab>('health');

// The tab pattern: one tab stop, ← → Home End move between tabs and select.
const TABS: AnalysisTab[] = ['health', 'size', 'validation', 'compatibility'];
const TAB_LABEL_KEYS: Record<AnalysisTab, string> = {
	health: 'builder.analysis.tabs.health',
	size: 'builder.analysis.tabs.size',
	validation: 'builder.analysis.tabs.validation',
	compatibility: 'builder.analysis.tabs.compatibility',
};
const uid = useId();
const bodyId = `ep-analysis-body-${uid}`;
const tabId = (tab: AnalysisTab) => `ep-analysis-tab-${tab}-${uid}`;
const panelId = `ep-analysis-panel-${uid}`;
const tabRefs = ref<HTMLButtonElement[]>([]);

function onTabKeydown(event: KeyboardEvent) {
	const current = TABS.indexOf(activeTab.value);
	let next = current;
	if (event.key === 'ArrowRight') next = (current + 1) % TABS.length;
	else if (event.key === 'ArrowLeft') next = (current - 1 + TABS.length) % TABS.length;
	else if (event.key === 'Home') next = 0;
	else if (event.key === 'End') next = TABS.length - 1;
	else return;
	event.preventDefault();
	activeTab.value = TABS[next]!;
	tabRefs.value[next]?.focus();
}

// Error count drives the badge on the Validation tab.
const errorCount = computed(
	() => props.validationIssues.filter((i) => i.severity === 'error').length
);

// Summary for the collapsed header.
const headerSummary = computed(() => {
	if (props.healthScore) {
		return t('builder.analysis.score', { score: Math.round(props.healthScore.overall) });
	}
	if (props.emailAnalysis) {
		return `${(props.emailAnalysis.htmlSizeBytes / 1024).toFixed(1)} KB`;
	}
	return t('builder.analysis.title');
});
</script>

<template>
	<div class="ep-analysis-panel">
		<!-- Collapsible Header -->
		<button
			type="button"
			class="ep-analysis-header"
			:aria-expanded="expanded"
			:aria-controls="expanded ? bodyId : undefined"
			@click="emit('toggle')"
		>
			<div class="ep-analysis-header-left">
				<ChartBarVerticalIcon class="ep-analysis-header-icon" aria-hidden="true" />
				<span class="ep-analysis-header-title">{{ t('builder.analysis.title') }}</span>
				<span class="ep-analysis-header-summary">{{ headerSummary }}</span>
				<SpinnerIcon v-if="isAnalyzing" class="ep-analysis-spinner" />
			</div>
			<ChevronDownIcon
				aria-hidden="true"
				class="ep-analysis-chevron"
				:class="{ 'ep-analysis-chevron-open': expanded }"
			/>
		</button>

		<!-- Expanded Content -->
		<div v-if="expanded" :id="bodyId" class="ep-analysis-body">
			<!-- Tabs -->
			<div class="ep-analysis-tabs" role="tablist" @keydown="onTabKeydown">
				<button
					v-for="(tab, index) in TABS"
					:id="tabId(tab)"
					:key="tab"
					:ref="
						(el) => {
							if (el) tabRefs[index] = el as HTMLButtonElement;
						}
					"
					type="button"
					role="tab"
					class="ep-analysis-tab"
					:class="{ 'ep-analysis-tab-active': activeTab === tab }"
					:aria-selected="activeTab === tab"
					:aria-controls="panelId"
					:tabindex="activeTab === tab ? 0 : -1"
					@click="activeTab = tab"
				>
					{{ t(TAB_LABEL_KEYS[tab]) }}
					<span
						v-if="tab === 'validation' && errorCount > 0"
						class="ep-analysis-tab-badge ep-badge-error"
						>{{ errorCount }}</span
					>
				</button>
			</div>

			<!-- Tab Content -->
			<div
				:id="panelId"
				class="ep-analysis-tab-content"
				role="tabpanel"
				:aria-labelledby="tabId(activeTab)"
			>
				<div class="ep-analysis-section">
					<HealthTab v-if="activeTab === 'health'" :health-score="healthScore" />
					<SizeTab v-else-if="activeTab === 'size'" :email-analysis="emailAnalysis" />
					<ValidationTab
						v-else-if="activeTab === 'validation'"
						:validation-issues="validationIssues"
					/>
					<CompatibilityTab
						v-else
						:compatibility-report="compatibilityReport"
						:compatibility-error="compatibilityError ?? null"
						:selected-client-name="selectedClientName ?? null"
						:is-analyzing="isAnalyzing ?? false"
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
	transition: transform var(--motion-moderate, 160ms)
		var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
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
	transition-property: color, border-color;
	transition-duration: var(--motion-fast, 80ms);
	transition-timing-function: var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
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
