<script setup lang="ts">
/**
 * THE CONTROLS FOR ONE CELL — pause, pin, force-advance, reset to a phase.
 *
 * WHAT EACH CONTROL PROMISES IS STATED NEXT TO IT, not in a help centre. A pause
 * suppresses increases and NOT retreats; a pin caps the climb and never holds a
 * cell up; a force-advance is the only one that can lose reputation and is the
 * only one behind a typed confirmation. Those are the sentences an operator
 * needs at the moment they decide, so they are the sentences on the buttons.
 *
 * THE COMPONENT DOES NOT WRITE. It emits intent; the page owns the mutations,
 * so every write goes through one org-scoped authed call site and the refusal
 * handling is not duplicated per control.
 */
import { FORCE_ADVANCE_CONFIRMATION } from '@owlat/shared/deliverabilityIndependence';
import { rampCellLabel, shareLabel, type RampCellControl } from '~/utils/deliverabilityRamp';

const props = defineProps<{
	cell: RampCellControl;
	busy?: boolean;
}>();

const emit = defineEmits<{
	pause: [isPaused: boolean];
	pin: [share: number | null];
	forceAdvance: [share: number];
	resetPhase: [phaseCeiling: number];
}>();

const headingId = useId();
const pinInputId = useId();
const forceInputId = useId();

/** Percent-typed inputs: operators think in points, the API takes a share. */
const pinPercent = ref(Math.round((props.cell.pinnedShare ?? props.cell.ownShare) * 100));
const forcePercent = ref(Math.round(props.cell.ownShare * 100));

const PHASE_RUNGS = [0.25, 0.5, 0.8, 1] as const;

const isDisabled = computed(() => props.busy === true || !props.cell.isRampManaged);

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, Math.round(value)));
}
</script>

<template>
	<section :aria-labelledby="headingId" class="space-y-4" data-testid="ramp-cell-controls">
		<header>
			<h3 :id="headingId" class="text-base font-semibold text-text-primary">
				{{ rampCellLabel(cell.cell) }}
			</h3>
			<p class="mt-1 text-sm text-text-secondary">
				Currently at {{ shareLabel(cell.ownShare) }} on your own server.
			</p>
		</header>

		<!--
			NOT A WARNING. Most cells in most deployments have never been ramp-managed,
			and that is a normal state of a working install, not something to fix.
		-->
		<p
			v-if="!cell.isRampManaged"
			class="text-sm text-text-secondary"
			data-testid="ramp-controls-unmanaged"
		>
			This cell is not on the ramp yet, so there is nothing to control. It joins on its own once the
			controller starts managing its share — no setup needed.
		</p>

		<div class="flex flex-wrap gap-2">
			<button
				type="button"
				:disabled="isDisabled"
				class="rounded-md border border-border-subtle px-3 py-2 text-sm disabled:opacity-50"
				data-testid="ramp-control-pause"
				@click="emit('pause', !cell.isPaused)"
			>
				{{ cell.isPaused ? 'Resume this cell' : 'Pause this cell' }}
			</button>
		</div>
		<p class="text-xs text-text-secondary">
			Pausing holds the share where it is. The checks keep running and an automatic retreat still
			happens — a pause never blocks a safety response.
		</p>

		<div class="flex flex-wrap items-end gap-2">
			<div>
				<label :for="pinInputId" class="block text-xs text-text-secondary">Pin at (%)</label>
				<input
					:id="pinInputId"
					v-model.number="pinPercent"
					type="number"
					min="0"
					max="100"
					class="w-24 rounded-md border border-border-subtle bg-bg-base px-2 py-1 text-sm"
					data-testid="ramp-control-pin-input"
				/>
			</div>
			<button
				type="button"
				:disabled="isDisabled"
				class="rounded-md border border-border-subtle px-3 py-2 text-sm disabled:opacity-50"
				data-testid="ramp-control-pin"
				@click="emit('pin', clampPercent(pinPercent) / 100)"
			>
				Pin
			</button>
			<button
				v-if="cell.pinnedShare !== null"
				type="button"
				:disabled="isDisabled"
				class="rounded-md border border-border-subtle px-3 py-2 text-sm disabled:opacity-50"
				data-testid="ramp-control-unpin"
				@click="emit('pin', null)"
			>
				Remove pin
			</button>
		</div>
		<p class="text-xs text-text-secondary">
			A pin is a ceiling, not a floor: the ramp climbs to it on the usual evidence and stops there.
		</p>

		<div class="flex flex-wrap items-end gap-2">
			<div>
				<label :for="forceInputId" class="block text-xs text-text-secondary"> Force to (%) </label>
				<input
					:id="forceInputId"
					v-model.number="forcePercent"
					type="number"
					min="0"
					max="100"
					class="w-24 rounded-md border border-border-subtle bg-bg-base px-2 py-1 text-sm"
					data-testid="ramp-control-force-input"
				/>
			</div>
			<button
				type="button"
				:disabled="isDisabled"
				class="rounded-md border border-border-subtle px-3 py-2 text-sm disabled:opacity-50"
				data-testid="ramp-control-force-advance"
				@click="emit('forceAdvance', clampPercent(forcePercent) / 100)"
			>
				Force-advance…
			</button>
		</div>
		<p class="text-xs text-text-secondary" data-testid="ramp-force-advance-warning">
			Force-advance moves the share past the evidence. It asks you to type “{{
				FORCE_ADVANCE_CONFIRMATION
			}}” first, because a bad move here costs weeks of reputation and cannot be undone by putting
			the number back.
		</p>

		<div class="flex flex-wrap items-center gap-2">
			<span class="text-xs text-text-secondary">Reset to phase</span>
			<button
				v-for="rung in PHASE_RUNGS"
				:key="rung"
				type="button"
				:disabled="isDisabled"
				class="rounded-md border border-border-subtle px-2 py-1 text-sm disabled:opacity-50"
				:data-testid="`ramp-control-phase-${rung}`"
				@click="emit('resetPhase', rung)"
			>
				{{ Math.round(rung * 100) }}%
			</button>
		</div>
		<p class="text-xs text-text-secondary">
			Resetting a phase restarts the clean streak: the cell re-earns its way up from the rung you
			pick.
		</p>
	</section>
</template>
