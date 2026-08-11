<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { data: memory, isLoading: memoryLoading } = useConvexQuery(
	api.inbox.clarificationMemory.listClarificationMemory,
	() => ({})
);
const { data: strategyCatalog } = useConvexQuery(
	api.plugins.draftStrategySelections.listCatalog,
	() => ({})
);
const { run: revokeMemory } = useBackendOperation(
	api.inbox.clarificationMemory.revokeClarificationMemory,
	{ label: 'Forget learned answer' }
);
const { run: promoteMemory } = useBackendOperation(
	api.inbox.clarificationMemory.promoteClarificationMemory,
	{ label: 'Use learned answer for everyone' }
);
const { run: setStrategy } = useBackendOperation(api.plugins.draftStrategySelections.setSelection, {
	label: 'Set draft strategy',
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
		if (await revokeMemory({ id })) showToast('Learned answer forgotten');
	} finally {
		memoryPendingId.value = null;
	}
}
async function useForEveryone(id: Id<'clarificationMemory'>) {
	memoryPendingId.value = id;
	try {
		if (await promoteMemory({ id })) showToast('Learned answer now applies to every sender');
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
		if (result !== undefined) showToast('Draft strategy updated for ' + category);
	} finally {
		strategyPendingCategory.value = null;
	}
}
</script>

<template>
	<UiCard v-if="strategyCatalog" class="mt-6">
		<div class="mb-5 flex items-start gap-3">
			<UiIconBox icon="lucide:route" size="sm" variant="surface" />
			<div>
				<h2 class="font-medium text-text-primary">Draft strategies</h2>
				<p class="mt-1 text-sm text-text-secondary">
					Choose a bundled drafting strategy for each message category. Default uses Owlat's
					built-in drafter.
				</p>
			</div>
		</div>
		<div class="grid gap-3 sm:grid-cols-2">
			<UiSelect
				v-for="category in categories"
				:key="category"
				:model-value="selectedStrategy(category)"
				:label="category.replace('_', ' ')"
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
			<UiIconBox icon="lucide:brain" size="sm" variant="surface" />
			<div>
				<h2 class="font-medium text-text-primary">Learned answers</h2>
				<p class="mt-1 text-sm text-text-secondary">
					Answers you gave when the agent needed a missing fact. Forget stale answers or carefully
					widen a contact-specific answer to every sender.
				</p>
			</div>
		</div>
		<div v-if="memoryLoading" class="py-6 text-center"><UiSpinner /></div>
		<p v-else-if="!memory?.items.length" class="py-6 text-center text-sm text-text-tertiary">
			No learned answers yet.
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
						{{ item.scope === 'org_general' ? 'All senders' : item.contactName || 'One contact' }}
						· answered {{ item.answerCount }} time{{ item.answerCount === 1 ? '' : 's' }}
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
						Use for everyone
					</UiButton>
					<UiButton
						variant="ghost"
						size="sm"
						class="text-error hover:text-error"
						:disabled="memoryPendingId === item.id"
						@click="forgetAnswer(item.id)"
					>
						Forget
					</UiButton>
				</div>
			</div>
		</div>
	</UiCard>
</template>
