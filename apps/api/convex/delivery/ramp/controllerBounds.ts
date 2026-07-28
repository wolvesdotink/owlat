/**
 * THE TWO BOUNDS THE LADDER APPLIES — the evaluation WINDOW and the CAPACITY
 * ceiling.
 *
 * Both are pure functions of their inputs and neither is a rung: `controller.ts`
 * stays the precedence ladder and nothing else, which is the property a reviewer
 * has to be able to verify in one sitting.
 *
 * PURE, like everything else under `ramp/`: no clock, no database, no
 * environment. `now` is a parameter.
 */

import { OWN_SHARE_CEILING } from '@owlat/shared/deliverabilityRouting';
import { RAMP_AIMD } from './controllerConfig';
import { isStoredInstantAhead, readStoredInstant } from './controllerReaders';
import type { RampCapacityInput } from './controllerTypes';

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
 * A projected volume of zero is not unusable, it is "nothing to send", which
 * imposes no capacity limit at all; such a cell is bounded by its phase ceiling
 * and — far earlier — by gates that cannot reach their sample floors.
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
	if (!Number.isFinite(projectedVolume) || projectedVolume < 0) return null;
	if (projectedVolume === 0) return OWN_SHARE_CEILING;
	const ratio = (warmingCapRemaining / projectedVolume) * RAMP_AIMD.capacitySafety;
	if (!Number.isFinite(ratio)) return null;
	return Math.min(OWN_SHARE_CEILING, Math.max(0, ratio));
}
