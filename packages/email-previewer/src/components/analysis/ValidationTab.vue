<script setup lang="ts">
import { ref, computed } from 'vue';
import { AlertCircle, AlertTriangle, Info } from '@lucide/vue';
import type { PreviewValidationIssue } from '../../types';
import AnalysisEmpty from './AnalysisEmpty.vue';

const props = defineProps<{
	validationIssues: PreviewValidationIssue[];
}>();

const severityFilter = ref<Set<string>>(new Set(['error', 'warning', 'info']));

const filteredIssues = computed(() => {
	return props.validationIssues.filter((i) => severityFilter.value.has(i.severity));
});

const issueCounts = computed(() => {
	const counts = { error: 0, warning: 0, info: 0 };
	for (const issue of props.validationIssues) {
		counts[issue.severity]++;
	}
	return counts;
});

function toggleSeverity(severity: string) {
	const newSet = new Set(severityFilter.value);
	if (newSet.has(severity)) {
		newSet.delete(severity);
	} else {
		newSet.add(severity);
	}
	severityFilter.value = newSet;
}
</script>

<template>
	<template v-if="validationIssues.length > 0">
		<!-- Severity filters -->
		<div class="ep-validation-filters">
			<button
				class="ep-validation-filter"
				:class="{ 'ep-filter-active': severityFilter.has('error') }"
				@click="toggleSeverity('error')"
			>
				<AlertCircle class="ep-filter-icon ep-filter-error" />
				Errors ({{ issueCounts.error }})
			</button>
			<button
				class="ep-validation-filter"
				:class="{ 'ep-filter-active': severityFilter.has('warning') }"
				@click="toggleSeverity('warning')"
			>
				<AlertTriangle class="ep-filter-icon ep-filter-warning" />
				Warnings ({{ issueCounts.warning }})
			</button>
			<button
				class="ep-validation-filter"
				:class="{ 'ep-filter-active': severityFilter.has('info') }"
				@click="toggleSeverity('info')"
			>
				<Info class="ep-filter-icon ep-filter-info" />
				Info ({{ issueCounts.info }})
			</button>
		</div>

		<!-- Issues list -->
		<div class="ep-validation-issues">
			<div
				v-for="(issue, idx) in filteredIssues"
				:key="idx"
				class="ep-validation-issue"
				:class="`ep-issue-${issue.severity}`"
			>
				<component
					:is="issue.severity === 'error' ? AlertCircle : issue.severity === 'warning' ? AlertTriangle : Info"
					class="ep-issue-icon"
				/>
				<div class="ep-issue-content">
					<div class="ep-issue-message">{{ issue.message }}</div>
					<div class="ep-issue-meta">
						<span v-if="issue.blockType" class="ep-issue-badge">{{ issue.blockType }}</span>
						<span v-if="issue.code" class="ep-issue-code">{{ issue.code }}</span>
					</div>
				</div>
			</div>
		</div>
	</template>
	<AnalysisEmpty v-else success>No validation issues found.</AnalysisEmpty>
</template>

<style scoped>
.ep-validation-filters {
	display: flex;
	gap: 6px;
	margin-bottom: 12px;
}

.ep-validation-filter {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 4px 8px;
	background: var(--ep-bg-elevated);
	border: 1px solid var(--ep-border-subtle);
	border-radius: 6px;
	color: var(--ep-text-tertiary);
	font-size: 11px;
	cursor: pointer;
	transition: all 0.1s ease;
}

.ep-filter-active {
	border-color: var(--ep-border-default);
	color: var(--ep-text-secondary);
	background: var(--ep-bg-surface-hover);
}

.ep-filter-icon {
	width: 12px;
	height: 12px;
}

.ep-filter-error {
	color: var(--ep-error);
}

.ep-filter-warning {
	color: var(--ep-warning);
}

.ep-filter-info {
	color: var(--ep-text-tertiary);
}

.ep-validation-issues {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.ep-validation-issue {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	padding: 8px 10px;
	border-radius: 6px;
	background: var(--ep-bg-elevated);
}

.ep-issue-icon {
	width: 14px;
	height: 14px;
	flex-shrink: 0;
	margin-top: 1px;
}

.ep-issue-error .ep-issue-icon {
	color: var(--ep-error);
}

.ep-issue-warning .ep-issue-icon {
	color: var(--ep-warning);
}

.ep-issue-info .ep-issue-icon {
	color: var(--ep-text-tertiary);
}

.ep-issue-content {
	flex: 1;
	min-width: 0;
}

.ep-issue-message {
	font-size: 12px;
	color: var(--ep-text-secondary);
	line-height: 1.4;
}

.ep-issue-meta {
	display: flex;
	gap: 6px;
	margin-top: 4px;
}

.ep-issue-badge {
	padding: 1px 5px;
	background: var(--ep-bg-overlay);
	border-radius: 4px;
	font-size: 10px;
	font-weight: 500;
	color: var(--ep-text-tertiary);
}

.ep-issue-code {
	font-size: 10px;
	font-family: var(--ep-font-mono);
	color: var(--ep-text-tertiary);
}
</style>
