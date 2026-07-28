<script setup lang="ts">
/**
 * ONE CELL'S DECISION HISTORY — every evaluation, including the no-ops.
 *
 * The no-op rows are the POINT, not noise to be filtered out. A history that
 * only showed changes would answer "what moved" and never "was the controller
 * even looking", which is the question an operator actually has when a share has
 * sat still for a week (plan D12).
 *
 * The sentence is the controller's own, verbatim. Composing a second one here
 * would let the screen and the audit row describe the same retreat differently,
 * and an operator would have no way to tell which the controller acted on.
 */
import { rampReasonLabel, shareLabel, type RampCellDecision } from '~/utils/deliverabilityRamp';
import { formatShortDate } from '~/utils/formatters';

defineProps<{
	decisions: readonly RampCellDecision[];
	labelledBy: string;
}>();
</script>

<template>
	<div :aria-labelledby="labelledBy">
		<p
			v-if="decisions.length === 0"
			class="text-sm text-text-secondary"
			data-testid="ramp-timeline-empty"
		>
			No decisions recorded for this cell yet. The controller writes one every time it looks, so
			this fills in on its own.
		</p>
		<ol v-else class="space-y-3" data-testid="ramp-decision-timeline">
			<li
				v-for="decision in decisions"
				:key="decision.at"
				class="border-l-2 border-border-subtle pl-3"
				:data-direction="decision.direction"
			>
				<p class="text-xs text-text-secondary">
					<time :datetime="new Date(decision.at).toISOString()">
						{{ formatShortDate(decision.at) }}
					</time>
					·
					<span data-testid="ramp-decision-move">
						{{ shareLabel(decision.fromShare) }} → {{ shareLabel(decision.toShare) }}
					</span>
					·
					<span data-testid="ramp-decision-reason">{{ rampReasonLabel(decision.reason) }}</span>
				</p>
				<p class="text-sm text-text-primary">{{ decision.message }}</p>
				<p
					v-if="decision.adminNotice !== null"
					class="mt-1 text-sm text-text-secondary"
					data-testid="ramp-decision-notice"
				>
					{{ decision.adminNotice }}
				</p>
			</li>
		</ol>
	</div>
</template>
