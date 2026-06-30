<script setup lang="ts">
import { computed } from 'vue';
import { AlertCircle, AlertTriangle, Info } from '@lucide/vue';
import type { CompatibilityReport, NestingDepthResult } from '../../types';
import { scoreColor } from '../../scoreBands';
import AnalysisEmpty from './AnalysisEmpty.vue';

const props = defineProps<{
	compatibilityReport: CompatibilityReport | null;
	nestingDepthWarning?: NestingDepthResult | null;
}>();

const compatibilityIssues = computed(() => {
	if (!props.compatibilityReport) return { errors: [], warnings: [], info: [] };
	const issues = [...props.compatibilityReport.issues];
	if (props.nestingDepthWarning?.hasDeepNesting) {
		issues.unshift({
			severity: 'warning',
			feature: 'container-nesting',
			message: props.nestingDepthWarning.warningMessage || 'Deep container nesting may cause rendering issues',
			clients: ['Outlook (Windows)', 'Outlook (Mac)', 'Windows Mail'],
		});
	}
	return {
		errors: issues.filter((i) => i.severity === 'error'),
		warnings: issues.filter((i) => i.severity === 'warning'),
		info: issues.filter((i) => i.severity === 'info'),
	};
});

const compatibilityScore = computed(() => {
	return props.compatibilityReport?.score ?? null;
});

const compatibilityScoreColor = computed(() => {
	if (compatibilityScore.value === null) return 'var(--ep-text-tertiary)';
	return scoreColor(compatibilityScore.value);
});
</script>

<template>
	<template v-if="compatibilityReport">
		<!-- Score -->
		<div class="ep-compat-score">
			<span class="ep-compat-score-value" :style="{ color: compatibilityScoreColor }">
				{{ compatibilityScore }}%
			</span>
			<span class="ep-compat-score-label">compatible</span>
			<span class="ep-compat-clients">
				{{ compatibilityReport.testedClients.join(', ') }}
			</span>
		</div>

		<!-- Issues -->
		<div v-if="compatibilityIssues.errors.length > 0" class="ep-compat-group">
			<div class="ep-compat-group-title ep-compat-errors">
				<AlertCircle class="ep-compat-group-icon" />
				{{ compatibilityIssues.errors.length }} Error{{ compatibilityIssues.errors.length === 1 ? '' : 's' }}
			</div>
			<div
				v-for="(issue, idx) in compatibilityIssues.errors"
				:key="`e-${idx}`"
				class="ep-compat-issue"
			>
				<span class="ep-compat-feature">{{ issue.feature }}</span>
				<span class="ep-compat-message">{{ issue.message }}</span>
			</div>
		</div>
		<div v-if="compatibilityIssues.warnings.length > 0" class="ep-compat-group">
			<div class="ep-compat-group-title ep-compat-warnings">
				<AlertTriangle class="ep-compat-group-icon" />
				{{ compatibilityIssues.warnings.length }} Warning{{ compatibilityIssues.warnings.length === 1 ? '' : 's' }}
			</div>
			<div
				v-for="(issue, idx) in compatibilityIssues.warnings"
				:key="`w-${idx}`"
				class="ep-compat-issue"
			>
				<span class="ep-compat-feature">{{ issue.feature }}</span>
				<span class="ep-compat-message">{{ issue.message }}</span>
			</div>
		</div>
		<div v-if="compatibilityIssues.info.length > 0" class="ep-compat-group">
			<div class="ep-compat-group-title ep-compat-info">
				<Info class="ep-compat-group-icon" />
				{{ compatibilityIssues.info.length }} Note{{ compatibilityIssues.info.length === 1 ? '' : 's' }}
			</div>
			<div
				v-for="(issue, idx) in compatibilityIssues.info"
				:key="`i-${idx}`"
				class="ep-compat-issue"
			>
				<span class="ep-compat-feature">{{ issue.feature }}</span>
				<span class="ep-compat-message">{{ issue.message }}</span>
			</div>
		</div>
		<AnalysisEmpty
			v-if="compatibilityIssues.errors.length === 0 && compatibilityIssues.warnings.length === 0 && compatibilityIssues.info.length === 0"
			success
		>
			No compatibility issues found.
		</AnalysisEmpty>
	</template>
	<AnalysisEmpty v-else>Select a client above to analyze compatibility.</AnalysisEmpty>
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
</style>
