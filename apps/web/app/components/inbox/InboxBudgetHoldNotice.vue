<script setup lang="ts">
/**
 * A Team message held for a person because the AI spend budget was reached.
 * The pipeline ran none of its paid steps, so there is no draft:
 * the notice says why (which budget), what the AI did not do for it (the
 * skipped judgments), and offers Retry, which runs them once there is room.
 * Auto-send is blocked while it is held; Retry clears the hold and reruns the
 * normal pipeline, which may send on its own. Shown in place of the failed notice:
 * the message is `failed` with `budgetHold` set.
 */
import type { BudgetHold } from '~/utils/aiBudget';
import { BUDGET_REASON_KEYS, MISSING_JUDGMENT_KEYS } from '~/utils/aiBudget';
import { formatDateTime } from '~/utils/formatters';
import { ReloadIcon, WalletIcon } from '@coolicons/vue';

const props = defineProps<{
	hold: BudgetHold;
	retrying: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();

const { t } = useI18n();
const K = 'components.inbox.budgetHold';

const missing = computed(() => props.hold.missingJudgments.map((j) => t(MISSING_JUDGMENT_KEYS[j])));
</script>

<template>
	<div
		class="mt-4 rounded-lg bg-warning-subtle/50 p-3"
		role="status"
		data-testid="thread-budget-hold"
		:data-reason="hold.reason"
	>
		<p class="flex items-center gap-1.5 text-sm font-medium text-text-primary">
			<WalletIcon class="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
			{{ t(`${K}.title`) }}
		</p>
		<p class="mt-1 text-sm text-text-secondary">{{ t(BUDGET_REASON_KEYS[hold.reason]) }}</p>
		<p
			v-if="missing.length > 0"
			class="mt-1 text-xs text-text-secondary"
			data-testid="thread-budget-hold-missing"
		>
			{{ t(`${K}.missing`, { steps: missing.join(', ') }) }}
		</p>
		<p class="mt-1 text-xs text-text-tertiary">
			{{ t(`${K}.since`, { date: formatDateTime(hold.at) }) }}
		</p>
		<div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
			<UiButton
				variant="secondary"
				size="sm"
				class="gap-1"
				:disabled="retrying"
				@click="emit('retry')"
			>
				<ReloadIcon class="w-3 h-3" />
				{{ t(`${K}.retry`) }}
			</UiButton>
			<p class="text-xs text-text-secondary">{{ t(`${K}.retryHint`) }}</p>
		</div>
	</div>
</template>
