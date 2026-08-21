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

const { t, locale } = useI18n();

/**
 * The reason vocabulary in `utils/deliverabilityRamp` carries i18n keys rather
 * than sentences (the registry convention for module-scope definitions); a plain
 * string is still accepted, which is what an unknown reason falls back to.
 */
type LocalizedText = string | { key: string; params?: Record<string, unknown> };
function localized(value: LocalizedText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}
</script>

<template>
	<div :aria-labelledby="labelledBy">
		<p
			v-if="decisions.length === 0"
			class="text-sm text-text-secondary"
			data-testid="ramp-timeline-empty"
		>
			{{ t('components.delivery.rampDecisionTimeline.empty') }}
		</p>
		<ol v-else class="space-y-3" data-testid="ramp-decision-timeline">
			<!-- KEYED BY POSITION AS WELL AS INSTANT. Two evaluations of one cell can
			     share a millisecond — the controller writes a row every time it looks
			     — and duplicate keys make Vue reuse the wrong row. -->
			<li
				v-for="(decision, index) in decisions"
				:key="`${decision.at}:${index}`"
				class="border-l-2 border-border-subtle pl-3"
				:data-direction="decision.direction"
			>
				<p class="text-xs text-text-secondary">
					<time :datetime="new Date(decision.at).toISOString()">
						{{ formatShortDate(decision.at, locale) }}
					</time>
					·
					<span data-testid="ramp-decision-move">
						{{ shareLabel(decision.fromShare) }} → {{ shareLabel(decision.toShare) }}
					</span>
					·
					<span data-testid="ramp-decision-reason">
						{{ localized(rampReasonLabel(decision.reason)) }}
					</span>
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
