/**
 * THE OPERATOR'S HAND ON THE RAMP — pure, and applied AFTER the controller has
 * decided (plan D12, D15, P3-6).
 *
 * WHY THIS IS NOT A RUNG. The controller's precedence ladder encodes what the
 * EVIDENCE permits; an operator pause or pin encodes what a HUMAN currently
 * wants. Threading a control flag through the ladder would put those two
 * authorities in the same switch and make every one of the ladder's fixture
 * tests carry a field they do not care about. Instead the ladder runs untouched,
 * and this function rewrites the decision it produced — so the `mixDecisions`
 * row records what the operator's setting actually produced, not what the
 * controller would have done in a world without them.
 *
 * THE ONE-DIRECTIONAL RULE, AND IT IS THE WHOLE SAFETY ARGUMENT. A pause
 * suppresses INCREASES only. A pin CAPS increases only. Neither can hold a
 * retreat: a gate breach, a circuit breaker, a blocklist listing or a capacity
 * ceiling all still take the share down through an operator's pause, because a
 * safety response an operator can switch off is not a safety response. There is
 * deliberately no field in `RampCellControl` that could express "hold the share
 * up" — the shape refuses it, not a comment.
 *
 * FREEZES, STREAKS AND PINS ARE NEVER REWRITTEN. Only `share`, `ceiling`,
 * `reason` and the derived `direction` can change here. The cooldown ladder, the
 * clean streak, the green clock and the graduation pin are the controller's
 * durable measurement state, and an operator overriding the share must not be
 * able to make a cell look like it has earned something it has not.
 *
 * BOTH DIALS ARE GOVERNED — see `applyPaceCellControl` at the end of the file.
 * A pause reaches the pace ladder under the same one-directional rule, because
 * "hold this cell" cannot mean "hold the dial that happens to be the share" on a
 * deployment whose only dial is the warm-up pace.
 */

import { clampOwnShare } from '@owlat/shared/deliverabilityRouting';
import { rampDecisionDirection, type RampDecision } from './controllerTypes';
import type { PaceDecision } from './paceTypes';

/**
 * What an operator has set on one cell. Both members absent is the ordinary
 * case — the overwhelming majority of cells — and is a no-op by construction.
 */
export interface RampCellControl {
	/** Instant the operator paused this cell, or `undefined` if it is running. */
	readonly pausedAt: number | undefined;
	/** Share the operator pinned this cell at, or `undefined` if unpinned. */
	readonly pinnedShare: number | undefined;
}

/** A stored pin is only a pin if it reads as a share. */
function readPinnedShare(value: number | undefined): number | null {
	if (value === undefined) return null;
	if (!Number.isFinite(value)) return null;
	return clampOwnShare(value);
}

/**
 * Rewrite one decision under the operator's controls.
 *
 * Returns the SAME object when nothing applies, so the caller can tell an
 * overridden decision from an untouched one by identity if it wants to, and so
 * the ordinary path allocates nothing.
 */
export function applyRampCellControl(
	decision: RampDecision,
	control: RampCellControl
): RampDecision {
	const isRetreat = decision.share < decision.fromShare;
	// A RETREAT IS NEVER OVERRIDDEN. Checked first and once, so no rule below can
	// be read as qualifying it.
	if (isRetreat) return decision;

	const pinned = readPinnedShare(control.pinnedShare);

	// PAUSE BEATS PIN when both are set, because the operator's pause is the
	// stronger statement of the two: "do not move this cell" subsumes "do not
	// move it past here", and reporting the pin as the cause would send the
	// operator to un-pin a cell that would still not move.
	if (control.pausedAt !== undefined) {
		if (decision.share === decision.fromShare) {
			// Nothing to suppress. The controller's own reason is the true one and
			// keeping it is what stops a paused cell reporting `operator_pause` on
			// every one of the twenty-four ticks a day it was holding anyway.
			return decision;
		}
		return {
			...decision,
			share: decision.fromShare,
			ceiling: Math.min(decision.ceiling, decision.fromShare),
			reason: 'operator_pause',
			direction: 'hold',
		};
	}

	if (pinned === null || decision.share <= pinned) return decision;

	// THE SAME NO-OP GUARD THE PAUSE ARM HAS, and for a sharper reason. A pin
	// stored BELOW the cell's current share sits above nothing the controller
	// wanted to do on a hold, so without this guard every ordinary hold —
	// `frozen`, `evidence_stale`, `awaiting_corroboration`, `capacity_ceiling`,
	// `building_confidence` — would be relabelled `operator_pin` and the Cells
	// grid's "Holding it back" column would name the operator instead of the
	// constraint that is actually binding. It would also be untrue twice over:
	// the share shown is `fromShare`, not the pinned share.
	if (decision.share === decision.fromShare) return decision;

	const share = Math.max(pinned, decision.fromShare);
	// `ceiling` IS ONLY NARROWED WHERE THE PIN ACTUALLY BOUND THE SHARE. Pinning
	// at 0.2 a cell already running at 0.7 must not record `share: 0.7,
	// ceiling: 0.2` — a self-contradictory evidence row for anyone replaying the
	// decision later.
	const ceiling = share <= pinned ? Math.min(decision.ceiling, pinned) : decision.ceiling;
	return {
		...decision,
		share,
		ceiling,
		reason: 'operator_pin',
		direction: rampDecisionDirection(decision.fromShare, share),
	};
}

/**
 * THE SAME HAND, ON THE SECOND DIAL (plan D3, P3-6).
 *
 * WHY IT EXISTS. `setCellPause` succeeds on any managed cell, but the share
 * override above only ever reaches the SHARE. On a pace-actuated cell — a
 * deployment with no reference transport, which is the configuration the
 * standalone twin exists for — the share is not the dial that moves, so a paused
 * cell went on taking its daily +STEP on the warming cap while the control that
 * was supposed to hold it reported success. A control that silently governs
 * nothing is worse than one that refuses.
 *
 * THE ONE-DIRECTIONAL RULE IS THE SHARE'S, unchanged and for the same reason: a
 * pause suppresses INCREASES only. Every retreat — a gate breach, an open
 * breaker, a blocklist listing, an abuse suspension — still takes the multiplier
 * down through a pause, checked first and once so no rule below can be read as
 * qualifying it.
 *
 * THE PIN DOES NOT TRAVEL HERE, and its absence is deliberate rather than
 * pending: `pinnedShare` is a SHARE, and the pace dial is a MULTIPLIER on a daily
 * cap. There is no honest conversion between the two units, and inventing one
 * would let "cap this cell at 40% of its traffic" quietly become a number about
 * volume. An operator who needs a pace-actuated cell held has the pause, and
 * `rampControls` says so on the row it writes.
 *
 * FREEZES, STREAKS AND THE COUNTED DAY ARE NEVER REWRITTEN, exactly as on the
 * share side. In particular the day the suppressed evaluation counted STAYS
 * counted: it is measurement state, the operator's hand did not make the window
 * unmeasured, and leaving it counted is also what keeps the remaining
 * twenty-three ticks of the day reporting the constraint that is really binding
 * (`day_already_advanced`) instead of relabelling every one of them
 * `operator_pause`.
 */
export function applyPaceCellControl(
	decision: PaceDecision,
	control: RampCellControl
): PaceDecision {
	// A RETREAT IS NEVER OVERRIDDEN.
	if (decision.multiplier < decision.fromMultiplier) return decision;
	if (control.pausedAt === undefined) return decision;
	// Nothing to suppress — the controller's own reason is the true one, and the
	// same no-op guard the share's pause arm carries.
	if (decision.multiplier === decision.fromMultiplier) return decision;
	return {
		...decision,
		multiplier: decision.fromMultiplier,
		reason: 'operator_pause',
		direction: 'hold',
	};
}
