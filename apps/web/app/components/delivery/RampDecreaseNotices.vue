<script setup lang="ts">
/**
 * WHAT THE CONTROLLER PULLED BACK, AND WHY (plan D12).
 *
 * EVERY DECREASE with a named cause carries an admin notice naming the gate that
 * broke and what to do about it. A controller that silently retreats will be
 * experienced as a bug, so this list is where those retreats become visible —
 * and the sentence is the controller's own, read back verbatim rather than
 * recomposed, so the screen cannot describe a retreat differently from the audit
 * row that recorded it.
 *
 * AN EMPTY LIST IS GOOD NEWS AND SAYS SO. It is not an empty state to apologise
 * for and it is not styled as one.
 */
import {
	rampCellKeyLabel,
	rampReasonLabel,
	shareLabel,
	type RampAdminNotice,
} from '~/utils/deliverabilityRamp';
import { formatShortDate } from '~/utils/formatters';

defineProps<{
	notices: readonly RampAdminNotice[];
	labelledBy: string;
}>();
</script>

<template>
	<div :aria-labelledby="labelledBy">
		<p
			v-if="notices.length === 0"
			class="text-sm text-text-secondary"
			data-testid="ramp-notices-empty"
		>
			Nothing has been pulled back. Every automatic retreat shows up here, naming the check that
			broke and what to do about it.
		</p>
		<ul v-else class="space-y-3" data-testid="ramp-notices">
			<li
				v-for="notice in notices"
				:key="`${notice.cellKey}:${notice.at}`"
				class="rounded-lg border border-border-subtle p-3"
				:data-cell="notice.cellKey"
			>
				<p class="text-xs text-text-secondary">
					<time :datetime="new Date(notice.at).toISOString()">
						{{ formatShortDate(notice.at) }}
					</time>
					·
					<span data-testid="ramp-notice-cell">{{ rampCellKeyLabel(notice.cellKey) }}</span>
					·
					<span data-testid="ramp-notice-gate">
						{{ notice.failedGate === null ? 'Hard stop' : rampReasonLabel(notice.failedGate) }}
					</span>
					·
					<span data-testid="ramp-notice-move">
						{{ shareLabel(notice.fromShare) }} → {{ shareLabel(notice.toShare) }}
					</span>
				</p>
				<p class="mt-1 text-sm text-text-primary" data-testid="ramp-notice-text">
					{{ notice.notice }}
				</p>
			</li>
		</ul>
	</div>
</template>
