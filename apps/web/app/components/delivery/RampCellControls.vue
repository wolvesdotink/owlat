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
 * AND EVERY ONE OF THEM SAYS WHICH DIAL IT ACTS ON. Both controls are expressed
 * in SHARE, but the share is only the dial the controller CLIMBS where a relay is
 * carrying the cell; everywhere else it is the warm-up pace, which a pause holds
 * and a pin cannot bound at all. The pre-click promise and the audit row the
 * server writes afterwards are read by the same operator about the same click, so
 * a sentence here that named the wrong dial would be contradicted by that row six
 * weeks later. See `rampControlMessages.ts` for the server's half.
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
	 * WHETHER A RELAY IS CONFIGURED AT ALL (plan D14) — `isRelayConfigured` off the
	 * controls view. NOT `referenceTransportId !== null`, which names the SINGLE
	 * second arm and is null on a two-relay deployment.
	 *
	 * ON ITS OWN IT ANSWERS NO NOTE ON THIS CARD, and that is the correction this
	 * component needed. Every sentence here turns on one of two questions, and
	 * neither is "is a relay configured":
	 *
	 *   - WHICH DIAL IS CLIMBING — the pause and pin notes. That is per cell and
	 *     MEASURED (`cell.isShareRamped`, the tick's own `bindsPhaseLadder`
	 *     reading). A relay configured but carrying nothing this window leaves the
	 *     controller on the pace dial, so copy cut on configuration promised a
	 *     share the server's own audit row then denied.
	 *   - IS THERE A SECOND SENDER TO HOLD A SHARE BACK FOR — the reset and promote
	 *     notes. That is `hasSecondSender` below: CONFIGURED OR MEASURED, the exact
	 *     union `resetCellPhase` cuts a share on and `promotionMessage` words its
	 *     row off. Configuration alone gets the other direction wrong — a relay
	 *     disconnected today but still carrying this cell inside the window makes
	 *     the server cut a share this copy would say it holds.
	 *
	 * REQUIRED, so the compiler holds it. Optional, an absent prop read as "there
	 * is a relay" and restored a 75% cut in front of a deployment that cannot make
	 * it. A caller who has to state the fact cannot forget it.
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
/**
 * THE SECOND-SENDER UNION, held once. `resetCellPhase` cuts a share on
 * `configuredRelayKinds().length > 0 || bindsPhaseLadder(...)` and
 * `promotionMessage` words its row off the same union, so the two notes that
 * describe those doors ask for it here rather than each rebuilding it — the card
 * carries both halves, so the predicate is one expression and not a judgement.
 */
const hasSecondSender = computed(() => props.hasRelayConfigured || props.cell.isShareRamped);

const promoteNote = computed(() => {
	if (!isPromotable.value)
		return 'This cell is already on the top phase rung, so there is nothing left to promote.';
	const effect = hasSecondSender.value
		? 'Promoting raises the ceiling one rung and re-shuffles which arm every recipient of this cell lands in.'
		: 'Promoting raises the ceiling one rung. Nothing is carrying this cell but your own server, so there is no second arm to shuffle recipients between: the rung is recorded and binds the day a second sender carries this cell again.';
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
			<UiButton
				variant="outline"
				size="sm"
				:disabled="busy === true"
				data-testid="ramp-control-enroll"
				@click="emit('enroll')"
			>
				Put this cell on the ramp
			</UiButton>
		</div>

		<div class="flex flex-wrap gap-2">
			<UiButton
				variant="outline"
				size="sm"
				:disabled="isDisabled"
				data-testid="ramp-control-pause"
				@click="emit('pause', !cell.isPaused)"
			>
				{{ cell.isPaused ? 'Resume this cell' : 'Pause this cell' }}
			</UiButton>
		</div>
		<p class="text-xs text-text-secondary" data-testid="ramp-pause-note">
			{{
				cell.isShareRamped
					? 'Pausing holds both dials where they are — the share and the warm-up pace. A relay is carrying this cell, so the share is the dial that climbs and that is the number a pause freezes.'
					: 'Pausing holds both dials where they are — the share and the warm-up pace. Nothing is carrying this cell but your own server, so the share is not the dial that climbs: the warm-up pace is, and a pause is the only control that holds it.'
			}}
			The checks keep running and an automatic retreat still happens — a pause never blocks a safety
			response.
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
					class="input input-sm w-24"
					data-testid="ramp-control-pin-input"
				/>
			</div>
			<UiButton
				variant="outline"
				size="sm"
				:disabled="isDisabled"
				data-testid="ramp-control-pin"
				@click="emit('pin', clampPercent(pinPercent) / 100)"
			>
				Pin
			</UiButton>
			<UiButton
				v-if="cell.pinnedShare !== null"
				variant="outline"
				size="sm"
				:disabled="isDisabled"
				data-testid="ramp-control-unpin"
				@click="emit('pin', null)"
			>
				Remove pin
			</UiButton>
		</div>
		<p class="text-xs text-text-secondary" data-testid="ramp-pin-note">
			A pin is a ceiling, not a floor: it holds an increase back, and never pulls a cell that is
			already higher down to the number you type.
			{{
				cell.isShareRamped
					? 'A relay is carrying this cell, so the share is the dial that climbs and the pin bounds it: the ramp climbs to the pin on the usual evidence and stops there.'
					: 'Nothing is carrying this cell but your own server, so the warm-up pace is the dial that climbs, and no pin can bound it — pausing the cell is what holds it. The pin is still recorded against the share, and bounds the climb again the day a relay carries this cell.'
			}}
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
					class="input input-sm w-24"
					data-testid="ramp-control-force-input"
				/>
			</div>
			<UiButton
				variant="outline"
				size="sm"
				:disabled="isDisabled"
				data-testid="ramp-control-force-advance"
				@click="emit('forceAdvance', clampPercent(forcePercent) / 100)"
			>
				Force-advance…
			</UiButton>
		</div>
		<p class="text-xs text-text-secondary" data-testid="ramp-force-advance-warning">
			Force-advance moves the share past the evidence. It asks you to type “{{
				FORCE_ADVANCE_CONFIRMATION
			}}” first, because a bad move here costs weeks of reputation and cannot be undone by putting
			the number back.
		</p>

		<div class="flex flex-wrap items-center gap-2">
			<span class="text-xs text-text-secondary">Reset to phase</span>
			<UiButton
				v-for="rung in PHASE_RUNGS"
				:key="rung"
				variant="outline"
				size="sm"
				:disabled="isDisabled || !isRungOffered(rung)"
				:data-testid="`ramp-control-phase-${rung}`"
				@click="emit('resetPhase', rung)"
			>
				{{ Math.round(rung * 100) }}%
			</UiButton>
		</div>
		<p class="text-xs text-text-secondary" data-testid="ramp-reset-note">
			{{
				hasSecondSender
					? 'Resetting a phase restarts the clean streak and brings the share back under the rung you pick: the cell re-earns its way up from there.'
					: 'Resetting a phase restarts the clean streak. Nothing is carrying this cell but your own server, so there is no second sender to hand traffic to: the rung is recorded and your share stays where it is, and it binds again the day a second sender appears.'
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
			<UiButton
				variant="outline"
				size="sm"
				:disabled="isDisabled || !isPromotable"
				data-testid="ramp-control-promote-phase"
				@click="emit('promotePhase')"
			>
				Promote a phase
			</UiButton>
		</div>
		<p class="text-xs text-text-secondary" data-testid="ramp-promote-note">
			{{ promoteNote }}
		</p>
	</section>
</template>
