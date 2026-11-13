<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { BrainIcon, RouteIcon } from '@coolicons/vue';

const { t } = useI18n();

// A failed read is not "nothing remembered" and not "no strategies": both
// cards show the error with a retry instead.
const {
	data: memory,
	isLoading: memoryLoading,
	error: memoryError,
	refetch: refetchMemory,
} = useConvexQuery(api.inbox.clarificationMemory.listClarificationMemory, () => ({}));
const {
	data: strategyCatalog,
	isLoading: strategyLoading,
	error: strategyError,
	refetch: refetchStrategies,
} = useConvexQuery(api.plugins.draftStrategySelections.listCatalog, () => ({}));
const { run: revokeMemory } = useBackendOperation(
	api.inbox.clarificationMemory.revokeClarificationMemory,
	{ label: () => t('components.autonomy.autonomyLearningControls.forgetOperation') }
);
const { run: promoteMemory } = useBackendOperation(
	api.inbox.clarificationMemory.promoteClarificationMemory,
	{ label: () => t('components.autonomy.autonomyLearningControls.promoteOperation') }
);
const { run: setStrategy } = useBackendOperation(api.plugins.draftStrategySelections.setSelection, {
	label: () => t('components.autonomy.autonomyLearningControls.setStrategyOperation'),
});
const { showToast } = useToast();
const memoryPendingId = ref<string | null>(null);
const strategyPendingCategory = ref<string | null>(null);
const categories = [
	'support',
	'sales',
	'billing',
	'feature_request',
	'complaint',
	'spam',
	'internal',
	'other',
];

async function forgetAnswer(id: Id<'clarificationMemory'>) {
	memoryPendingId.value = id;
	try {
		if ((await revokeMemory({ id })).ok)
			showToast(t('components.autonomy.autonomyLearningControls.forgottenToast'));
	} finally {
		memoryPendingId.value = null;
	}
}
async function useForEveryone(id: Id<'clarificationMemory'>) {
	memoryPendingId.value = id;
	try {
		if ((await promoteMemory({ id })).ok)
			showToast(t('components.autonomy.autonomyLearningControls.promotedToast'));
	} finally {
		memoryPendingId.value = null;
	}
}
function selectedStrategy(category: string): string {
	return (
		strategyCatalog.value?.selections.find(
			(selection) => selection.scopeType === 'classification' && selection.scopeId === category
		)?.strategyKind ?? 'default'
	);
}
async function updateStrategy(category: string, strategyKind: string | number | null) {
	if (strategyKind === null) return;
	strategyPendingCategory.value = category;
	try {
		const result = await setStrategy({
			scope: { type: 'classification', id: category },
			strategyKind: String(strategyKind),
		});
		if (result.ok)
			showToast(
				t('components.autonomy.autonomyLearningControls.strategyUpdatedToast', {
					category: t(`components.autonomy.autonomyLearningControls.categories.${category}`),
				})
			);
	} finally {
		strategyPendingCategory.value = null;
	}
}
</script>

<template>
	<UiCard v-if="strategyCatalog || strategyLoading || strategyError" class="mt-6">
		<div class="mb-5 flex items-start gap-3">
			<UiIconBox :icon="RouteIcon" size="sm" variant="surface" />
			<div>
				<h3 class="font-medium text-text-primary">
					{{ t('components.autonomy.autonomyLearningControls.strategiesTitle') }}
				</h3>
				<p class="mt-1 text-sm text-text-secondary">
					{{ t('components.autonomy.autonomyLearningControls.strategiesBody') }}
				</p>
			</div>
		</div>
		<UiQueryBoundary v-if="strategyError" :error="strategyError" @retry="refetchStrategies" />
		<div v-else-if="!strategyCatalog" class="grid gap-3 sm:grid-cols-2" aria-hidden="true">
			<UiSkeleton v-for="category in categories" :key="category" class="h-10 w-full" />
		</div>
		<div v-else class="grid gap-3 sm:grid-cols-2">
			<UiSelect
				v-for="category in categories"
				:key="category"
				:model-value="selectedStrategy(category)"
				:label="t(`components.autonomy.autonomyLearningControls.categories.${category}`)"
				:disabled="strategyPendingCategory === category"
				:options="
					strategyCatalog.strategies.map((strategy) => ({
						value: strategy.kind,
						label: strategy.label,
					}))
				"
				@update:model-value="updateStrategy(category, $event)"
			/>
		</div>
	</UiCard>

	<UiCard class="mt-6">
		<div class="mb-5 flex items-start gap-3">
			<UiIconBox :icon="BrainIcon" size="sm" variant="surface" />
			<div>
				<h3 class="font-medium text-text-primary">
					{{ t('components.autonomy.autonomyLearningControls.memoryTitle') }}
				</h3>
				<p class="mt-1 text-sm text-text-secondary">
					{{ t('components.autonomy.autonomyLearningControls.memoryBody') }}
				</p>
			</div>
		</div>
		<div v-if="memoryLoading" class="py-6 text-center"><UiSpinner /></div>
		<UiQueryBoundary v-else-if="memoryError" :error="memoryError" @retry="refetchMemory" />
		<p v-else-if="!memory?.items.length" class="py-6 text-center text-sm text-text-tertiary">
			{{ t('components.autonomy.autonomyLearningControls.memoryEmpty') }}
		</p>
		<div v-else class="divide-y divide-border-subtle">
			<div
				v-for="item in memory.items"
				:key="item.id"
				class="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
			>
				<div class="min-w-0">
					<p class="text-sm font-medium text-text-primary">{{ item.questionText }}</p>
					<p class="mt-1 text-sm text-text-secondary">{{ item.answerValue }}</p>
					<p class="mt-1 text-xs text-text-tertiary">
						{{
							t(
								'components.autonomy.autonomyLearningControls.answeredTimes',
								{
									scope:
										item.scope === 'org_general'
											? t('components.autonomy.autonomyLearningControls.scopeAllSenders')
											: item.contactName ||
												t('components.autonomy.autonomyLearningControls.scopeOneContact'),
									count: item.answerCount,
								},
								item.answerCount
							)
						}}
					</p>
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<UiButton
						v-if="item.scope === 'contact'"
						variant="secondary"
						size="sm"
						:disabled="memoryPendingId === item.id"
						@click="useForEveryone(item.id)"
					>
						{{ t('components.autonomy.autonomyLearningControls.useForEveryone') }}
					</UiButton>
					<UiButton
						variant="danger-ghost"
						size="sm"
						:disabled="memoryPendingId === item.id"
						@click="forgetAnswer(item.id)"
					>
						{{ t('components.autonomy.autonomyLearningControls.forget') }}
					</UiButton>
				</div>
			</div>
		</div>
	</UiCard>
</template>
