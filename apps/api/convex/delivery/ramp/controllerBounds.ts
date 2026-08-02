/**
 * THE BOUNDS THE LADDER APPLIES — the evaluation WINDOW, the CAPACITY ceiling,
 * and the ceiling ARITHMETIC that decides which of the three possible ceilings
 * actually binds.
 *
 * All of it is a pure function of its inputs and none of it is a rung:
 * `controller.ts` stays the precedence ladder and nothing else, which is the
 * property a reviewer has to be able to verify in one sitting.
 *
 * PURE, like everything else under `ramp/`: no clock, no database, no
 * environment. `now` is a parameter.
 */

import { OWN_SHARE_CEILING } from '@owlat/shared/deliverabilityRouting';
import { RAMP_AIMD } from './controllerConfig';
import { isStoredInstantAhead, readStoredInstant } from './controllerReaders';
import type { RampIntegrationId } from './degradationMatrix';
import type { RampCapacityInput, RampControllerInput, RampDecisionReason } from './controllerTypes';

/**
 * Has a whole evaluation window elapsed since the last COUNTED one?
 *
 * The cron ticks hourly against a 24h outcome window, so without this the same
 * day of data would be counted 24 times and K_CLEAN = 3 would cost three hours
 * instead of three days. A window counts once.
 *
 * Degenerate anchors fail CLOSED, in the direction that cannot advance a cell:
 * an anchor AHEAD of the clock reads as "just counted" (hold), while an absent
 * or unreadable one reads as "never counted" — there is no anchor to have
 * counted against, and refusing forever would strand the cell.
 */
export function isEvaluationWindowElapsed(lastCountedAt: number | undefined, now: number): boolean {
	if (isStoredInstantAhead(lastCountedAt, now)) return false;
	const anchor = readStoredInstant(lastCountedAt, now);
	if (anchor === null) return true;
	return now - anchor >= RAMP_AIMD.evaluationWindowMs;
}

/**
 * The capacity ceiling. `null` means the projection was UNUSABLE — a hold, not
 * an unbounded ceiling: a controller that treated an unreadable projection as
 * "no limit" would ramp hardest exactly when it understood the least.
 *
 * A projected volume of ZERO is one of those unusable readings and HOLDS too
 * (plan P3-3): a deployment we measured no demand for is a deployment we cannot
 * size a ceiling for, and `headroom / 0` is the division the whole degenerate
 * rule exists to forbid. Neither an infinite ceiling nor a zero one — a hold.
 */
export function capacityCeiling(capacity: RampCapacityInput): number | null {
	// NO WARMING READING AT ALL is not a spent cap: the cell is bounded by its
	// phase ceiling alone (plan D2 — absence never constrains). It is a distinct
	// SHAPE, not a pair of zeros, precisely so it cannot be confused with a cell
	// whose cap is spent and whose volume is zero.
	if (capacity.kind === 'unconstrained') return OWN_SHARE_CEILING;
	// A KNOWN CAP OVER AN UNKNOWN DEMAND is the opposite case, and the one the
	// projection reports for a brand-new cell, a paused week or the last sliver
	// of a UTC day. There is no ceiling to compute, so the cell HOLDS (plan D10):
	// never an unbounded ceiling, never a zero one, and never a division by a
	// projection of zero — that division is refused in `projectCellVolume`, one
	// module upstream, and this is where the refusal arrives.
	if (capacity.kind === 'unknown') return null;
	const { warmingCapRemaining, projectedVolume } = capacity;
	if (!Number.isFinite(warmingCapRemaining) || warmingCapRemaining < 0) return null;
	// ZERO IS NOT "NO LIMIT". A zero denominator is refused here as well as one
	// module upstream (`projectCellVolume` answers `no_volume` rather than a
	// projection of zero), so no caller — present or future — can reach the
	// division. Both refusals answer the same thing: HOLD.
	if (!Number.isFinite(projectedVolume) || projectedVolume <= 0) return null;
	const ratio = (warmingCapRemaining / projectedVolume) * RAMP_AIMD.capacitySafety;
	if (!Number.isFinite(ratio)) return null;
	return Math.min(OWN_SHARE_CEILING, Math.max(0, ratio));
}

/** The two PHASE bounds a tick applies, and the cause the cap would name. */
export interface RampPhaseBounds {
	readonly phaseCeiling: number;
	readonly phaseCeilingCap: number;
	readonly ceilingCapSource: RampIntegrationId | undefined;
}

/**
 * WHICH PHASE BOUNDS THIS TICK ACTUALLY APPLIES (plan D3).
 *
 * The ladder bounds the SHARE dial — how much of a cell the own MTA carries
 * while the rest stays with a second sender — so it bounds only a cell that HAS
 * one. `isPhaseLadderBinding` is the substitution fold's answer, re-read every
 * tick from observed traffic, and when it is false BOTH phase bounds fall away:
 * the stored rung and the table's cap on it would otherwise pull mail back
 * toward a destination the deployment does not have.
 *
 * IT NEVER TOUCHES THE STORED RUNG. `nextShare` carries `mix.phaseCeiling` out on
 * the decision and the write path puts it back unchanged, so a cell that later
 * acquires a second sender stands exactly where it was promoted to and has to
 * earn every rung above it through the promotion gate. Encoding "no ceiling
 * applies" as the ladder's TOP RUNG instead — on the row, at enrolment — would
 * bank a ceiling nobody was promoted to, and the AIMD ladder could then climb to
 * full share with that gate never consulted.
 *
 * NO CAUSE TO NAME when nothing binds: `ceilingCapSource` travels with the cap
 * it explains, so dropping the cap drops the name with it (plan D12).
 */
export function phaseLadderBounds(
	input: RampControllerInput,
	phaseCeiling: number
): RampPhaseBounds {
	if (!input.isPhaseLadderBinding) {
		return {
			phaseCeiling: OWN_SHARE_CEILING,
			phaseCeilingCap: OWN_SHARE_CEILING,
			ceilingCapSource: undefined,
		};
	}
	return {
		phaseCeiling,
		phaseCeilingCap: input.phaseCeilingCap,
		ceilingCapSource: input.ceilingCapSource,
	};
}

/** Which of the three ceilings bound the cell, and — for the cap — what caused it. */
export interface RampCeilingBound {
	/** The effective ceiling: the LOWEST of the three, never above full share. */
	readonly ceiling: number;
	readonly reason: RampDecisionReason;
	/**
	 * The absent integration whose table entry produced the cap, present ONLY when
	 * `reason` is `degradation_ceiling`. It travels with the bound rather than
	 * being looked up again by the narrative, so the sentence an operator reads
	 * and the number the controller applied cannot name different integrations.
	 */
	readonly cappedBy: RampIntegrationId | undefined;
}

/**
 * WHICH CEILING BINDS IS PART OF THE REASON (plan D12). Three of them can, and
 * they have three different remedies: grow the warming schedule, promote the
 * phase, or reconnect the missing feed. Collapsing the last two into
 * `phase_ceiling` would tell an operator to promote a rung the controller is
 * itself capping — advice that cannot work until the feed comes back.
 *
 * THE SUBSTITUTION TABLE'S CAP IS A BOUND, NEVER A STORED RUNG (P3-8): an absent
 * SNDS feed caps the Microsoft cell one phase lower while it is missing and
 * stops capping it the tick the feed returns, without anyone re-promoting the
 * cell. Degenerate caps are ignored rather than honoured — a NaN cap must not
 * become a ceiling of NaN — which keeps this arithmetic incapable of raising
 * anything.
 */
export function resolveCeilingBound(
	args: RampPhaseBounds & { readonly capacityBound: number }
): RampCeilingBound {
	const { capacityBound, phaseCeiling, phaseCeilingCap, ceilingCapSource } = args;
	const capBound = Number.isFinite(phaseCeilingCap) ? Math.max(0, phaseCeilingCap) : phaseCeiling;
	const effectivePhaseCeiling = Math.min(phaseCeiling, capBound);
	const ceiling = Math.min(OWN_SHARE_CEILING, capacityBound, effectivePhaseCeiling);
	if (capacityBound < effectivePhaseCeiling) {
		return { ceiling, reason: 'capacity_ceiling', cappedBy: undefined };
	}
	if (capBound < phaseCeiling) {
		return { ceiling, reason: 'degradation_ceiling', cappedBy: ceilingCapSource };
	}
	return { ceiling, reason: 'phase_ceiling', cappedBy: undefined };
}
