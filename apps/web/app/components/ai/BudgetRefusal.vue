<script setup lang="ts">
/**
 * A stored AI result the spend budget refused: an assistant answer, an
 * @assistant reply or a visualization. The server keeps the stable code and
 * reason (`{ code: 'AI_BUDGET_EXHAUSTED', reason }`), never a sentence, so the
 * reader gets it in their own language. Renders nothing for anything else.
 */
import { BUDGET_REASON_KEYS, budgetRefusalReason } from '~/utils/aiBudget';

const props = defineProps<{
	refusal: unknown;
	/** `inline`: one quiet line under a message; `panel`: in place of a result. */
	variant?: 'inline' | 'panel';
}>();

const { t } = useI18n();

const reason = computed(() => budgetRefusalReason(props.refusal));
</script>

<template>
	<p
		v-if="reason && variant !== 'panel'"
		class="mt-1 text-xs text-error"
		data-testid="ai-budget-refusal"
		:data-reason="reason"
	>
		{{ t('shared.aiBudget.title') }} {{ t(BUDGET_REASON_KEYS[reason]) }}
	</p>
	<div
		v-else-if="reason"
		class="rounded-lg bg-warning-subtle/50 p-3"
		role="status"
		data-testid="ai-budget-refusal"
		:data-reason="reason"
	>
		<p class="flex items-center gap-1.5 text-sm font-medium text-text-primary">
			<Icon name="lucide:wallet" class="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
			{{ t('shared.aiBudget.title') }}
		</p>
		<p class="mt-1 text-sm text-text-secondary">{{ t(BUDGET_REASON_KEYS[reason]) }}</p>
	</div>
</template>
