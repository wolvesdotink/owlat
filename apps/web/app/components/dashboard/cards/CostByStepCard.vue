<script setup lang="ts">
import { api } from '@owlat/api';

const { data: cost, isLoading } = useOrganizationQuery(api.agentHealth.getCostByStep);

interface CostStep {
	step: string;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	actionCount: number;
}

const steps = computed<CostStep[]>(() => cost.value?.steps ?? []);
const totalTokens = computed(() => cost.value?.totalTokens ?? 0);

const maxTokens = computed(() => {
	return Math.max(...steps.value.map((s) => s.totalTokens), 1);
});

const STEP_LABELS: Record<string, string> = {
	security_scan: 'Security Scan',
	context_retrieval: 'Context Retrieval',
	classify: 'Classify',
	draft: 'Draft',
	route: 'Route',
};

function stepLabel(step: string): string {
	return STEP_LABELS[step] ?? step;
}

function formatTokens(n: number): string {
	return n.toLocaleString();
}
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiIconBox icon="lucide:coins" size="sm" variant="brand" />
					<h3 class="text-sm font-semibold text-text-primary">LLM Cost by Step</h3>
				</div>
				<span class="text-xs text-text-tertiary">last 24h</span>
			</div>

			<div v-if="isLoading" class="flex items-center justify-center py-6">
				<Icon
					name="lucide:loader-2"
					class="w-5 h-5 animate-spin text-text-tertiary"
					aria-label="Loading"
				/>
			</div>

			<div v-else-if="steps.length === 0" class="py-4 text-center">
				<p class="text-sm text-text-tertiary">No token usage recorded yet</p>
			</div>

			<div v-else>
				<div class="flex items-baseline gap-2 mb-4">
					<span class="text-3xl font-bold text-text-primary">{{ formatTokens(totalTokens) }}</span>
					<span class="text-sm text-text-secondary">tokens used</span>
				</div>

				<ul class="space-y-2.5" aria-label="Token usage per pipeline step">
					<li v-for="item in steps" :key="item.step">
						<div class="flex items-center justify-between mb-1">
							<span class="text-xs text-text-secondary">{{ stepLabel(item.step) }}</span>
							<span class="text-xs font-medium text-text-primary">{{
								formatTokens(item.totalTokens)
							}}</span>
						</div>
						<div
							class="h-1.5 bg-bg-surface rounded-full overflow-hidden"
							role="progressbar"
							:aria-valuenow="item.totalTokens"
							:aria-valuemin="0"
							:aria-valuemax="totalTokens"
							:aria-label="`${stepLabel(item.step)}: ${formatTokens(item.totalTokens)} tokens across ${item.actionCount} actions`"
						>
							<div
								class="h-full bg-brand rounded-full transition-all duration-(--motion-slow)"
								:style="{ width: `${(item.totalTokens / maxTokens) * 100}%` }"
							/>
						</div>
						<p class="text-xs text-text-tertiary mt-0.5">
							{{ item.actionCount }} {{ item.actionCount === 1 ? 'action' : 'actions' }}
						</p>
					</li>
				</ul>
			</div>
		</div>
	</UiCard>
</template>
