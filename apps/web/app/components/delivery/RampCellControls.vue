<script setup lang="ts">
/**
 * THE CONTROLS FOR ONE CELL — enrol, pause, pin, force-advance, reset or promote
 * a phase.
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
	/**
	 * WHETHER A RELAY IS CONFIGURED AT ALL (plan D14) — `isRelayConfigured` off
	 * the controls view, which is the SAME FACT `resetCellPhase` cuts a share on.
	 * The phase rung bounds the SHARE dial, so with no second sender the rung is
	 * stored but DORMANT: the server takes it and leaves the share alone. Saying
	 * so is the difference between a control that reads as a 75% cut and one that
	 * reads as what it does.
	 *
	 * NOT `referenceTransportId !== null`. That names the single second arm and is
	 * null on a deployment with TWO relays — where the server cuts, and this copy
	 * used to promise the share would stay where it is.
	 *
	 * The server also cuts on a relay it MEASURED carrying this cell in the last
	 * day, which configuration alone cannot see once one is disconnected; the
	 * standalone sentence below states that clause rather than denying it.
	 *
	 * BOTH NOTES READ IT. A promotion's other half is plan D7's mix generation,
	 * and "which arm every recipient lands in" is the same second-sender fact: a
	 * standalone cell has ONE arm, so the generation is spent and re-shuffles
	 * nobody. Promising the shuffle there describes a split that does not exist.
	 *
	 * REQUIRED, so the compiler holds it. Optional, an absent prop read as "there
	 * is a relay" and restored the "brings the share back" copy — a 75% cut — in
	 * front of the standalone deployment that cannot make it. A caller who has to
	 * state the fact cannot forget it.
	 */
	hasRelayConfigured: boolean;
	busy?: boolean;
}>();

const emit = defineEmits<{
	enroll: [];
	pause: [isPaused: boolean];
	pin: [share: number | null];
	forceAdvance: [share: number];
	resetPhase: [phaseCeiling: number];
	promotePhase: [];
}>();

const headingId = useId();
const pinInputId = useId();
const forceInputId = useId();

/** Percent-typed inputs: operators think in points, the API takes a share. */
const pinPercent = ref(0);
const forcePercent = ref(0);

/**
 * RESYNC WHEN THE SELECTED CELL CHANGES.
 *
 * The page mounts this inside a `v-if`, so Vue reuses the instance when the
 * operator picks a different cell — and a `ref` seeded from props once would
 * keep the PREVIOUS cell's numbers in both boxes. Force-advance would then open
 * its confirmation proposing a share the operator never chose, for a cell they
 * were not looking at when they chose it. Watched on `cellKey` rather than on
 * the object so an unrelated re-render (a new decision arriving on the same
 * cell) does not discard what the operator is halfway through typing.
 */
watch(
	() => props.cell.cellKey,
	() => {
		pinPercent.value = Math.round((props.cell.pinnedShare ?? props.cell.ownShare) * 100);
		forcePercent.value = Math.round(props.cell.ownShare * 100);
	},
	{ immediate: true }
);

/**
 * The ladder's top rung: there is nothing above it to be promoted to. Named
 * BEFORE the ladder and spent as its last entry, so the two are the same value
 * by construction rather than by a lookup with an unreachable fallback — the
 * `??` in `rungFor` below is reachable (an empty filter) and must stay the only
 * fallback here that reads like one.
 */
const TOP_RUNG = 1;
const PHASE_RUNGS = [0.25, 0.5, 0.8, TOP_RUNG] as const;

const isDisabled = computed(() => props.busy === true || !props.cell.isRampManaged);

/**
 * The rung the cell stands on, read the way the SERVER reads it
 * (`normalizePhaseCeiling`): a stored ceiling snaps DOWN onto a rung, and an
 * absent or unreadable one sits on the ladder's FIRST rung.
 *
 * THE ROUNDING IS THE POINT, not a detail of the fallback. `phaseCeiling` is an
 * unconstrained number on the row, and a raw reading disagreed with the server
 * below the ladder: on a row carrying 0.1 the server accepts a reset to 0.25
 * while every rung button here was disabled, so the screen that owns the move
 * could not make it. Above the ladder it disagreed the other way — a stored 1.2
 * left "Promote a phase" live on a cell the server answers as already at the top.
 */
function rungFor(phaseCeiling: number | null): number {
	if (phaseCeiling === null || !Number.isFinite(phaseCeiling)) return PHASE_RUNGS[0];
	return PHASE_RUNGS.filter((rung) => rung <= phaseCeiling).at(-1) ?? PHASE_RUNGS[0];
}

const currentRung = computed(() => rungFor(props.cell.phaseCeiling));

/**
 * A RESET ONLY EVER GOES DOWN. Raising a ceiling is a PROMOTION and runs the
 * evidence routes; offering it as a reset button would present the ladder's most
 * expensive move as its cheapest, and the server would refuse it anyway.
 */
function isRungOffered(rung: number): boolean {
	return rung <= currentRung.value;
}

/**
 * AND THE TOP RUNG HAS NOTHING ABOVE IT. `promoteCellPhase` answers a cell that
 * is already there with `{applied: false}` and NO refusal, so a live button here
 * would fire a mutation, produce no sentence and no change, and read as broken.
 */
const isPromotable = computed(() => currentRung.value < TOP_RUNG);

/**
 * WHAT A PROMOTION DOES, ON THE PATH THIS DEPLOYMENT IS ON. The rung rises on
 * both paths; the arm re-shuffle is the ESP path's half, and a standalone cell
 * reaches this note from its first minute — a pace-path enrolment opens at full
 * share on the 25% rung, so the button is live there before anything else has
 * happened. Built here rather than as a nested ternary in the template: two
 * facts crossed is four sentences, and the template is where that stops being
 * readable.
 */
const promoteNote = computed(() => {
	if (!isPromotable.value)
		return 'This cell is already on the top phase rung, so there is nothing left to promote.';
	const effect = props.hasRelayConfigured
		? 'Promoting raises the ceiling one rung and re-shuffles which arm every recipient of this cell lands in.'
		: 'Promoting raises the ceiling one rung. With no relay connected there is no second arm to shuffle recipients between, so the rung is recorded and binds the day a second sender carries this cell again.';
	return `${effect} It checks the evidence for the next rung first, and says what is still outstanding if it is not there yet.`;
});

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
			NOT A WARNING, AND NOT A NAG. Most cells in most deployments have never been
			ramp-managed, and that is a normal state of a working install (plan D2) —
			but nothing puts a cell on the ramp on its own, so the invitation to do it
			belongs here, next to the sentence that says the cell is not on it.
		-->
		<div v-if="!cell.isRampManaged" class="space-y-2" data-testid="ramp-controls-unmanaged">
			<p class="text-sm text-text-secondary">
				This cell is not on the ramp yet, so there is nothing to control. Putting it on the ramp
				hands its share to the controller, which then moves it only on the evidence.
			</p>
			<button
				type="button"
				:disabled="busy === true"
				class="rounded-md border border-border-subtle px-3 py-2 text-sm disabled:opacity-50"
				data-testid="ramp-control-enroll"
				@click="emit('enroll')"
			>
				Put this cell on the ramp
			</button>
		</div>

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
				:disabled="isDisabled || !isRungOffered(rung)"
				class="rounded-md border border-border-subtle px-2 py-1 text-sm disabled:opacity-50"
				:data-testid="`ramp-control-phase-${rung}`"
				@click="emit('resetPhase', rung)"
			>
				{{ Math.round(rung * 100) }}%
			</button>
		</div>
		<p class="text-xs text-text-secondary" data-testid="ramp-reset-note">
			{{
				hasRelayConfigured
					? 'Resetting a phase restarts the clean streak and brings the share back under the rung you pick: the cell re-earns its way up from there.'
					: 'Resetting a phase restarts the clean streak. With no relay connected there is no second sender to hand traffic to, so the rung is recorded and your share stays where it is — unless this cell was still sending through a relay in the past day.'
			}}
			Only rungs at or below the cell's current {{ Math.round(currentRung * 100) }}% rung are a
			reset — going higher is a promotion, which is its own control below.
		</p>

		<!--
			ITS OWN ROW, NOT THE RESET ONE. A promotion is the ladder's most expensive
			move and its only upward one; sitting under a "Reset to phase" label it
			read as a reset option, which is the exact confusion this screen is trying
			to remove. And no trailing ellipsis: that is reserved for the control that
			opens a confirmation, and this one writes on the click.
		-->
		<div class="flex flex-wrap items-center gap-2">
			<button
				type="button"
				:disabled="isDisabled || !isPromotable"
				class="rounded-md border border-border-subtle px-3 py-2 text-sm disabled:opacity-50"
				data-testid="ramp-control-promote-phase"
				@click="emit('promotePhase')"
			>
				Promote a phase
			</button>
		</div>
		<p class="text-xs text-text-secondary" data-testid="ramp-promote-note">
			{{ promoteNote }}
		</p>
	</section>
</template>
