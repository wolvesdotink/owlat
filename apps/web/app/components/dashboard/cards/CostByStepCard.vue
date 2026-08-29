<script setup lang="ts">
import { api } from '@owlat/api';

const { t, locale } = useI18n();

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

/** Message keys, resolved per render so the labels follow the active locale. */
const STEP_LABEL_KEYS: Record<string, string> = {
	security_scan: 'components.dashboard.cards.costByStep.steps.securityScan',
	context_retrieval: 'components.dashboard.cards.costByStep.steps.contextRetrieval',
	classify: 'components.dashboard.cards.costByStep.steps.classify',
	draft: 'components.dashboard.cards.costByStep.steps.draft',
	route: 'components.dashboard.cards.costByStep.steps.route',
};

function stepLabel(step: string): string {
	const key = STEP_LABEL_KEYS[step];
	return key ? t(key) : step;
}

function formatTokens(n: number): string {
	return new Intl.NumberFormat(locale.value).format(n);
}
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiIconBox icon="lucide:coins" size="sm" variant="brand" />
					<h3 class="text-sm font-semibold text-text-primary">
						{{ t('components.dashboard.cards.costByStep.title') }}
					</h3>
				</div>
				<span class="text-xs text-text-tertiary">{{
					t('components.dashboard.cards.costByStep.window')
				}}</span>
			</div>

			<div v-if="isLoading" class="flex items-center justify-center py-6">
				<Icon
					name="lucide:loader-2"
					class="w-5 h-5 animate-spin motion-reduce:animate-none text-text-tertiary"
					:aria-label="t('components.dashboard.cards.costByStep.loading')"
				/>
			</div>

			<div v-else-if="steps.length === 0" class="py-4 text-center">
				<p class="text-sm text-text-tertiary">
					{{ t('components.dashboard.cards.costByStep.empty') }}
				</p>
			</div>

			<div v-else>
				<div class="flex items-baseline gap-2 mb-4">
					<span class="text-3xl font-bold text-text-primary">{{ formatTokens(totalTokens) }}</span>
					<span class="text-sm text-text-secondary">{{
						t('components.dashboard.cards.costByStep.tokensUsed')
					}}</span>
				</div>

				<ul class="space-y-2.5" :aria-label="t('components.dashboard.cards.costByStep.listLabel')">
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
							:aria-label="
								t('components.dashboard.cards.costByStep.barLabel', {
									step: stepLabel(item.step),
									tokens: formatTokens(item.totalTokens),
									actions: item.actionCount,
								})
							"
						>
							<div
								class="h-full bg-brand rounded-full transition-all duration-(--motion-slow)"
								:style="{ width: `${(item.totalTokens / maxTokens) * 100}%` }"
							/>
						</div>
						<p class="text-xs text-text-tertiary mt-0.5">
							{{
								t(
									'components.dashboard.cards.costByStep.actionCount',
									{ count: item.actionCount },
									item.actionCount
								)
							}}
						</p>
					</li>
				</ul>
			</div>
		</div>
	</UiCard>
</template>
