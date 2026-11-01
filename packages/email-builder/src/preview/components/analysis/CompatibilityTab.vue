<script setup lang="ts">
import { computed } from 'vue';
import { CircleInfoIcon, CircleWarningIcon, TriangleWarningIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';
import type { CompatibilityIssue, CompatibilityReport } from '../../types';
import { scoreColor } from '../../scoreBands';
import AnalysisEmpty from './AnalysisEmpty.vue';
import { useBuilderI18n } from '../../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

const props = defineProps<{
	compatibilityReport: CompatibilityReport | null;
	/** Why the analysis for the selected client failed, if it did. */
	compatibilityError: string | null;
	/** The client being analyzed; null when none is picked yet. */
	selectedClientName: string | null;
	isAnalyzing: boolean;
}>();

const compatibilityIssues = computed(() => {
	if (!props.compatibilityReport) return { errors: [], warnings: [], info: [] };
	const issues = props.compatibilityReport.issues;
	return {
		errors: issues.filter((i) => i.severity === 'error'),
		warnings: issues.filter((i) => i.severity === 'warning'),
		info: issues.filter((i) => i.severity === 'info'),
	};
});

/** Builder-written messages follow the locale; anything else is shown as written. */
function issueMessage(issue: CompatibilityIssue): string {
	return issue.messageKey ? t(issue.messageKey, issue.messageParams) : issue.message;
}

const compatibilityScore = computed(() => {
	return props.compatibilityReport?.score ?? null;
});

const compatibilityScoreColor = computed(() => {
	if (compatibilityScore.value === null) return 'var(--ep-text-tertiary)';
	return scoreColor(compatibilityScore.value);
});
</script>

<template>
	<AnalysisEmpty v-if="!selectedClientName">
		{{ t('builder.analysis.compatibility.selectClient') }}
	</AnalysisEmpty>
	<AnalysisEmpty v-else-if="isAnalyzing" class="ep-compat-pending" role="status">
		<SpinnerIcon class="ep-compat-spinner" aria-hidden="true" />
		{{ t('builder.analysis.compatibility.checking', { client: selectedClientName }) }}
	</AnalysisEmpty>
	<AnalysisEmpty
		v-else-if="compatibilityError"
		class="ep-compat-failed"
		role="alert"
		:title="compatibilityError"
	>
		<CircleWarningIcon class="ep-compat-failed-icon" aria-hidden="true" />
		{{ t('builder.analysis.compatibility.failed', { client: selectedClientName }) }}
	</AnalysisEmpty>
	<template v-else-if="compatibilityReport">
		<!-- Score -->
		<div class="ep-compat-score">
			<span class="ep-compat-score-value" :style="{ color: compatibilityScoreColor }">
				{{ compatibilityScore }}%
			</span>
			<span class="ep-compat-score-label">{{
				t('builder.analysis.compatibility.compatible')
			}}</span>
			<span class="ep-compat-clients">
				{{ compatibilityReport.testedClients.join(', ') }}
			</span>
		</div>

		<!-- Issues -->
		<div v-if="compatibilityIssues.errors.length > 0" class="ep-compat-group">
			<div class="ep-compat-group-title ep-compat-errors">
				<CircleWarningIcon class="ep-compat-group-icon" />
				{{
					t('builder.analysis.compatibility.errors', {
						count: compatibilityIssues.errors.length,
					})
				}}
			</div>
			<div
				v-for="(issue, idx) in compatibilityIssues.errors"
				:key="`e-${idx}`"
				class="ep-compat-issue"
			>
				<span class="ep-compat-feature">{{ issue.feature }}</span>
				<span class="ep-compat-message">{{ issueMessage(issue) }}</span>
			</div>
		</div>
		<div v-if="compatibilityIssues.warnings.length > 0" class="ep-compat-group">
			<div class="ep-compat-group-title ep-compat-warnings">
				<TriangleWarningIcon class="ep-compat-group-icon" />
				{{
					t('builder.analysis.compatibility.warnings', {
						count: compatibilityIssues.warnings.length,
					})
				}}
			</div>
			<div
				v-for="(issue, idx) in compatibilityIssues.warnings"
				:key="`w-${idx}`"
				class="ep-compat-issue"
			>
				<span class="ep-compat-feature">{{ issue.feature }}</span>
				<span class="ep-compat-message">{{ issueMessage(issue) }}</span>
			</div>
		</div>
		<div v-if="compatibilityIssues.info.length > 0" class="ep-compat-group">
			<div class="ep-compat-group-title ep-compat-info">
				<CircleInfoIcon class="ep-compat-group-icon" />
				{{
					t('builder.analysis.compatibility.notes', {
						count: compatibilityIssues.info.length,
					})
				}}
			</div>
			<div
				v-for="(issue, idx) in compatibilityIssues.info"
				:key="`i-${idx}`"
				class="ep-compat-issue"
			>
				<span class="ep-compat-feature">{{ issue.feature }}</span>
				<span class="ep-compat-message">{{ issueMessage(issue) }}</span>
			</div>
		</div>
		<AnalysisEmpty
			v-if="
				compatibilityIssues.errors.length === 0 &&
				compatibilityIssues.warnings.length === 0 &&
				compatibilityIssues.info.length === 0
			"
			success
		>
			{{ t('builder.analysis.compatibility.noIssues') }}
		</AnalysisEmpty>
	</template>
	<AnalysisEmpty v-else>
		{{ t('builder.analysis.compatibility.refresh', { client: selectedClientName }) }}
	</AnalysisEmpty>
</template>

<style scoped>
.ep-compat-score {
	display: flex;
	align-items: baseline;
	gap: 6px;
	margin-bottom: 12px;
}

.ep-compat-score-value {
	font-size: 24px;
	font-weight: 700;
}

.ep-compat-score-label {
	font-size: 12px;
	color: var(--ep-text-tertiary);
}

.ep-compat-clients {
	margin-left: auto;
	font-size: 11px;
	color: var(--ep-text-tertiary);
}

.ep-compat-group {
	margin-bottom: 12px;
}

.ep-compat-group-title {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 12px;
	font-weight: 600;
	margin-bottom: 6px;
}

.ep-compat-group-icon {
	width: 13px;
	height: 13px;
}

.ep-compat-errors {
	color: var(--ep-error);
}

.ep-compat-warnings {
	color: var(--ep-warning);
}

.ep-compat-info {
	color: var(--ep-text-tertiary);
}

.ep-compat-issue {
	display: flex;
	flex-direction: column;
	gap: 2px;
	padding: 6px 10px;
	border-radius: 6px;
	background: var(--ep-bg-elevated);
	margin-bottom: 4px;
}

.ep-compat-feature {
	font-size: 11px;
	font-weight: 500;
	color: var(--ep-text-primary);
}

.ep-compat-message {
	font-size: 11px;
	color: var(--ep-text-tertiary);
}

.ep-compat-spinner,
.ep-compat-failed-icon {
	flex-shrink: 0;
	width: 14px;
	height: 14px;
}

.ep-compat-spinner {
	animation: ep-compat-spin 1s linear infinite;
}

.ep-compat-failed-icon {
	color: var(--ep-error);
}

@keyframes ep-compat-spin {
	from {
		transform: rotate(0deg);
	}
	to {
		transform: rotate(360deg);
	}
}
</style>
