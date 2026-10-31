/**
 * ONE TICK OF THE RAMP CRON, DECIDED: which slice of the grid it takes, and
 * for each managed cell what the controller writes.
 *
 * `delivery/rampControllerCron.ts` loads the cell, calls `decideRampCell` and
 * applies the plan it returns, in this order: the `mixDecisions` row (always),
 * then either the lease alone or the decision, then the `auditLogs` row when
 * the plan carries one. Every outcome-changing conditional of the tick lives
 * here, so each one is a fixture rather than a branch in the shell.
 *
 * Pure: a total function of what the shell loaded and the injected `now`.
 */

import { deliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import type { AuditDetails } from '../../lib/auditLog';
import { composeActuators } from './actuatorComposition';
import { nextShare } from './controller';
import {
	rampDecisionChangedState,
	type RampControllerInput,
	type RampDecision,
} from './controllerTypes';
import {
	applyPaceCellControl,
	applyRampCellControl,
	type RampCellControl,
} from './controlOverride';
import type { RampDegradation } from './degradation';
import { nextPaceMultiplier } from './paceActuator';
import {
	paceDecisionChangedState,
	type PaceDecision,
	type PaceState,
	type PaceUtilisationReading,
} from './paceTypes';

/** Cells evaluated per tick. The grid is 15; three ticks cover it. */
export const RAMP_CELLS_PER_TICK = 5;

/** The cells one tick evaluates, as indices into the stable cell grid. */
export interface RampSlicePlan {
	readonly start: number;
	readonly end: number;
	/** The cursor of the self-scheduled next tick, `null` on the last slice. */
	readonly continueAt: number | null;
}

/**
 * Turn the tick's `cursor` into its slice, or `null` when the cursor is past
 * the grid and the tick has nothing to do. A cursor that is not a finite
 * number restarts the grid; a fractional one rounds down and a negative one
 * clamps to the first cell.
 */
export function planRampSlice(cursor: number | undefined, cellCount: number): RampSlicePlan | null {
	const raw = cursor ?? 0;
	const start = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
	if (start >= cellCount) return null;
	const end = Math.min(start + RAMP_CELLS_PER_TICK, cellCount);
	return { start, end, continueAt: end < cellCount ? end : null };
}

/** What the shell loaded for one managed cell. */
export interface RampCellDecisionInput {
	readonly input: RampControllerInput;
	/** The cell's substitution resolution, as `loadCellInput` returned it. */
	readonly degradation: RampDegradation;
	/** The pace dial's stored state (`readPaceState` of the per-stream row). */
	readonly pace: PaceState;
	/** The operator's per-cell pause and pin, off the per-stream row. */
	readonly control: RampCellControl;
	/** The pool-wide warming utilisation reading, shared by every cell in the tick. */
	readonly utilisation: PaceUtilisationReading;
	readonly isKillSwitchEngaged: boolean;
	readonly now: number;
}

/** The row write one cell gets after its `mixDecisions` row. */
export type RampCellWrite =
	/** A paused controller renews the row's lease and writes nothing else. */
	| { readonly kind: 'lease' }
	/** The decision is applied; `audit` is the `auditLogs` details, or `null` for none. */
	| { readonly kind: 'apply'; readonly audit: AuditDetails | null };

export interface RampCellPlan {
	/** The share decision, after the operator's controls. */
	readonly decision: RampDecision;
	/** The pace decision, after the operator's controls and the composition interlock. */
	readonly pace: PaceDecision;
	readonly isPaceDeferred: boolean;
	/** The pace half of the `mixDecisions` row: the decision, its evidence, the interlock. */
	readonly recordedPace: {
		readonly decision: PaceDecision;
		readonly utilisation: PaceUtilisationReading;
		readonly isDeferred: boolean;
	};
	readonly write: RampCellWrite;
}

/** Decide one managed cell: both dials, and what of it reaches the row and the audit log. */
export function decideRampCell(args: RampCellDecisionInput): RampCellPlan {
	const { input, degradation, control, isKillSwitchEngaged, now } = args;
	// WHICH DIAL THIS CELL DRIVES, off the substitution table and
	// not off a `hasRelay` boolean here: `resolveRampDegradation` returns
	// 'pace' exactly when the reference transport is absent, which is the
	// same mechanism that chose this cell's evaluator, its K_CLEAN and its
	// ceiling cap. Standalone is therefore the DEGENERATE CASE the
	// composition function already documents (`share: null`) rather than a
	// branch scattered through the controller.
	const isPaceActuated = degradation.actuator === 'pace';
	// THE OPERATOR'S HAND, applied AFTER the pure ladder and BEFORE anything is
	// recorded: a pause suppresses an increase and a pin caps one, and
	// neither can hold a retreat. Rewriting the decision here — rather than
	// threading a control flag through the ladder — is what keeps the audit row
	// honest: it records what the operator's setting actually produced, and the
	// controller's own rungs stay untouched.
	//
	// ONE READING OF THE CONTROLS FOR BOTH DIALS. A pause reaches the pace
	// ladder too (`applyPaceCellControl` below), because "hold this cell"
	// cannot mean "hold the share" on a deployment whose only dial is the
	// warm-up pace — the configuration the standalone twin exists for. The PIN
	// is share-only by construction and not by omission: it is expressed in
	// share, and the pace dial is a multiplier on a daily cap.
	const decision = applyRampCellControl(nextShare(input), control);
	// THE SECOND ACTUATOR, on the SAME gates, the SAME hard stops and the
	// SAME kill switch. Standalone it is the only dial that moves —
	// s === 1 by definition — and with a reference arm it is the slow,
	// reputation-bearing half of a composed decision.
	//
	// THE SAME HAND ON THIS DIAL, under the same one-directional rule and the
	// same override module: a pause suppresses the pace INCREASE and can never
	// hold the retreat. Applied here rather than after the composition so the
	// interlock below sees the decision the operator actually produced — a
	// suppressed increase is not an increase to defer, and stamping the
	// deferral anchor for one would hold this dial a further window after the
	// pause is lifted.
	const paceDecision = applyPaceCellControl(
		nextPaceMultiplier({
			config: input.config,
			pace: args.pace,
			signals: input.signals,
			evaluation: input.evaluation,
			utilisation: args.utilisation,
			// The table's step factor, RAW — see `PaceControllerInput.stepMultiplier`
			// for why it cannot travel folded into `config` the way K_CLEAN does.
			stepMultiplier: degradation.stepMultiplier,
			isKillSwitchEngaged,
			now,
		}),
		control
	);
	// THE COMPOSITION ORDER IS FIXED: share moves FIRST (cheap and
	// instantly reversible — the relay absorbs the difference), pace moves
	// SECOND (slow and reputation-bearing), and a cell may NEVER increase both
	// in one window. The interlock lives in one pure function so that
	// property is a fixture rather than an inline conditional — and it
	// is enforced in TWO places on purpose: this call withholds the step on
	// the tick the share moved, and the anchor it stamps
	// (`paceDeferredAt`) keeps the pace ladder holding for the rest of the
	// share's evaluation window. The cron ticks hourly; the window is a day.
	// A PACE-ACTUATED CELL HANDS THE COMPOSITION NO SHARE — the `share: null`
	// degenerate case the composition module documents, now reachable from
	// production. It is not cosmetic: the interlock defers a pace increase for
	// a WHOLE share evaluation window whenever the share stepped, so handing it
	// a live share decision on a deployment that has no reference transport to
	// shift traffic to would hold the only dial this cell owns for the entire
	// ramp — the headline deliverable of the standalone twin, starved.
	//
	// THE SHARE DECISION IS STILL APPLIED. Composition only ever holds the PACE
	// dial back, and the share half of the row is still the deployment's safety
	// interlock: a hard stop zeroes it, a critical blocklist freezes it, and
	// `isFallbackActive` is derived from it. Declining to write it on a
	// pace-actuated cell would silently drop shipped hard-stop behaviour on
	// exactly the configuration the pace actuator exists to serve.
	const composed = composeActuators({
		share: isPaceActuated ? null : decision,
		pace: paceDecision,
	});
	const plan = {
		decision,
		pace: composed.pace,
		isPaceDeferred: composed.isPaceDeferred,
		recordedPace: {
			decision: composed.pace,
			utilisation: args.utilisation,
			isDeferred: composed.isPaceDeferred,
		},
	};
	// A PAUSED CONTROLLER WRITES NO SHARE. It still evaluates, still audits —
	// so an operator can watch what it would have done — and still renews the
	// row's lease, because "pinned" has to survive longer than the cache TTL.
	if (isKillSwitchEngaged) return { ...plan, write: { kind: 'lease' } };
	return {
		...plan,
		write: { kind: 'apply', audit: rampDecisionAuditDetails(input, decision, composed.pace) },
	};
}

/**
 * The `auditLogs` details of an applied decision, or `null` when it changed
 * nothing worth logging.
 *
 * EVERY AUTOMATIC CHANGE IS AUDITED — which is a wider predicate
 * than "the share moved". A gate breach on a cell already sitting on
 * `RAMP_AIMD.shareFloor` returns direction 'hold' (`max(floor, floor x
 * 0.5)` is the floor), yet `applyDecision` rewrites the freeze
 * expiry, the cooldown rung, the clean streak, the green clock and the
 * graduation pin. That is a real automatic change and belongs in
 * `auditLogs`. `rampDecisionChangedState` is that predicate, and it is
 * SHARED with the admin notice rather than spelled out twice: the log and
 * the notice must never be able to disagree about whether something
 * happened. An ordinary hold rewrites nothing but the lease and stays out
 * of the log — see `rampDecisionAdminNotice` for why it is exact.
 *
 * THE PIN TRANSITION IS THE PIECE'S TERMINAL STATE CHANGE and it moves no
 * share at all: graduation holds the number (the pinned target IS the
 * current share) and imposes no freeze, while `applyDecision` writes
 * `graduatedAt` onto a row that had none — the cell pins and
 * the relay drops to `priority_failover` standby. `decision.pinChange`
 * carries that transition, so the tick a cell graduates — and the tick a
 * hard stop takes the pin away again — are both in the audit log.
 * AND THE SAME PREDICATE APPLIES TO THE SECOND DIAL, in the same shape as
 * `rampDecisionChangedState`: the dial MOVED, or a gate breach advanced
 * the cooldown ladder. A pace retreat on a cell whose share held is a real
 * automatic change and an operator cannot explain one no log records —
 * while a hard stop that is merely STILL TRUE an hour later re-stamps a
 * freeze without changing anything, and must stay as quiet here as it does
 * on the share side.
 *
 * BOTH PREDICATES ARE NAMED FUNCTIONS BESIDE THE DECISIONS THEY READ, so the
 * two halves cannot silently disagree about what "something happened" means.
 */
function rampDecisionAuditDetails(
	input: RampControllerInput,
	decision: RampDecision,
	pace: PaceDecision
): AuditDetails | null {
	if (!rampDecisionChangedState(decision) && !paceDecisionChangedState(pace)) return null;
	return {
		cell: deliverabilityCellKey(input.cell),
		fromShare: decision.fromShare,
		toShare: decision.share,
		direction: decision.direction,
		reason: decision.reason,
		verdict: decision.verdict,
		...(decision.failedGate === undefined ? {} : { failedGate: decision.failedGate }),
		...(decision.pinChange === undefined ? {} : { pinChange: decision.pinChange }),
		// The pace dial is part of the same automatic change and is logged
		// with it: an operator reading the audit trail must be able to see
		// which of the two dials moved, and why.
		fromPaceMultiplier: pace.fromMultiplier,
		toPaceMultiplier: pace.multiplier,
		paceDirection: pace.direction,
		paceReason: pace.reason,
	};
}
