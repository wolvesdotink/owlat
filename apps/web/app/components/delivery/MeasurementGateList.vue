<script setup lang="ts">
/**
 * The per-gate status list for one ramp cell (plan D12, D14).
 *
 * Every gate is rendered WITH the numbers that produced its verdict, because a
 * verdict nobody can check is not a measurement. A gate that is holding renders
 * in a neutral tone and says how far off its floor it is — "not enough data
 * yet, 124 of 400 sends this window" — never as a failure (plan D10/D2).
 *
 * Prop-driven and read-only: no writes, no controls. P3-6 owns the control
 * surface.
 */
import {
	gateExplanation,
	gateLabel,
	gateStatusLabel,
	gateTone,
	type DeliverabilityDashboardGate,
} from '~/utils/deliverabilityMeasurement';

const props = defineProps<{
	gates: readonly DeliverabilityDashboardGate[];
	/** Named so the corroboration caveat (D17) can point at the right gate. */
	failedGate: DeliverabilityDashboardGate['gate'] | null;
	requiresCorroboration: boolean;
}>();

const TONE_CLASS = {
	ok: 'border-success/40 bg-success/5 text-success',
	attention: 'border-warning/40 bg-warning/5 text-warning',
	stop: 'border-error/40 bg-error/5 text-error',
	neutral: 'border-border-subtle bg-bg-surface text-text-secondary',
} as const;

const rows = computed(() =>
	props.gates.map((gate) => ({
		gate,
		label: gateLabel(gate.gate),
		statusLabel: gateStatusLabel(gate.status),
		explanation: gateExplanation(gate),
		toneClass: TONE_CLASS[gateTone(gate.status)],
		isCorroborationPending:
			props.requiresCorroboration && props.failedGate === gate.gate && gate.status !== 'pass',
	}))
);
</script>

<template>
	<div>
		<h4 class="text-sm font-semibold text-text-primary">Checks</h4>
		<ul class="mt-2 space-y-2" data-testid="measurement-gate-list">
			<li
				v-for="row in rows"
				:key="row.gate.gate"
				:data-testid="`measurement-gate-${row.gate.gate}`"
				:data-status="row.gate.status"
				class="rounded-lg border p-3"
				:class="row.toneClass"
			>
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<span class="text-sm font-medium text-text-primary">{{ row.label }}</span>
					<span class="text-xs font-medium" data-testid="measurement-gate-status">
						{{ row.statusLabel }}
					</span>
				</div>
				<p class="mt-1 text-sm text-text-secondary" data-testid="measurement-gate-explanation">
					{{ row.explanation }}
				</p>
				<p
					v-if="row.isCorroborationPending"
					class="mt-1 text-xs text-text-secondary"
					data-testid="measurement-gate-corroboration"
				>
					This is a tripwire, not a measurement — it is confirmed against the bounce and deferral
					checks before anything acts on it.
				</p>
			</li>
		</ul>
	</div>
</template>
