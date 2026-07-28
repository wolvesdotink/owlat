/**
 * THE AIMD RAMP CONTROLLER — the pure decision function (plan D9, D10, D15).
 *
 * `nextShare` takes the cell, its stored mix state, the shipped hard-stop
 * signals, the gate aggregate and a capacity projection, and returns the share
 * to store plus the reason it chose. It is PURE: no `Date.now()`, no database,
 * no environment. The clock is a parameter. This is where the controller's
 * correctness lives, so it is exhaustively fixture-tested, and the cron
 * (`controllerCron.ts`) is a thin shell that loads, calls and writes.
 *
 * PRECEDENCE, and why the order is the safety property.
 *
 *   0. kill switch          — pin everything, in BOTH directions
 *   1. unusable clock       — never decide against a broken clock
 *   2. abuse status         -> 0
 *   3. circuit breaker      -> s x 0.5, freeze 6h
 *   4. critical blocklist   -> 0, freeze 24h
 *  4b. unreadable stored share -> hold at the clamped value; never add to a
 *                             number we cannot read
 *   5. active freeze        -> hold
 *  5a. no evaluation at all -> hold; the graduation clock stops
 *  5b. stale/skewed evidence -> hold; evidence has an expiry, both directions
 *   6. gate halt / fail     -> max(floor, s x 0.5), freeze COOLDOWN
 *   7. insufficient data    -> hold (plan D10: never up, and never DOWN either)
 *   8. capacity ceiling     — computed FIRST of the clean-path rungs, so even a
 *                             graduated cell is bounded by the warming cap
 *   9. graduation           -> award/keep the pin, and hold or lower to
 *                             max(floor, min(1, ceiling)); an upward pin target
 *                             falls through to 10/11 and is paid for like any
 *                             other increase
 *  10. K_CLEAN              -> hold while building confidence
 *  11. additive increase    -> min(ceiling, s + step), at most once per window
 *
 * Every rule above 11 either HOLDS or LOWERS the share. An increase is reachable
 * from exactly one branch, at the very bottom, and only after every hard stop
 * declined, the gate aggregate returned `pass`, the capacity projection was
 * usable and the clean streak reached K_CLEAN. That is the invariant the
 * adversarial fixtures exist to prove: no input — crafted, stale, degenerate or
 * hostile — can raise a share past a hard stop or on thin data.
 *
 * DEGENERATE INPUT FAILS CLOSED, never open. A NaN share resolves to the floor
 * through the shared `clampOwnShare`; a NaN or negative capacity projection
 * HOLDS rather than yielding an infinite ceiling; an out-of-ladder phase
 * ceiling snaps DOWN to the lowest rung. In every case the degenerate path is
 * the one that cannot increase.
 */

import { OWN_SHARE_CEILING } from '@owlat/shared/deliverabilityRouting';
import { normalizePhaseCeiling, RAMP_AIMD } from './controllerConfig';
import {
	isEvidenceUsable,
	isFreezeActive,
	isStoredInstantAhead,
	nextCooldownMs,
	readStoredInstant,
	roundShare,
	sanitizeGreenSince,
	sanitizeStreak,
} from './controllerReaders';
import { ppToFraction } from './gateConfig';
import type { RampGateId } from './gateTypes';
import type {
	RampCapacityInput,
	RampControllerInput,
	RampDecision,
	RampDecisionDirection,
	RampDecisionReason,
} from './controllerTypes';

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

function directionOf(fromShare: number, share: number): RampDecisionDirection {
	if (share > fromShare) return 'increase';
	if (share < fromShare) return 'decrease';
	return 'hold';
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
	// NO PROJECTION is not a spent cap: the cell is bounded by its phase ceiling
	// alone until P3-3 supplies a real per-cell reading (plan D2 — absence never
	// constrains). It is a distinct SHAPE, not a pair of zeros, precisely so it
	// cannot be confused with a cell whose cap is spent and whose volume is zero.
	if (capacity.kind === 'unconstrained') return OWN_SHARE_CEILING;
	const { warmingCapRemaining, projectedVolume } = capacity;
	if (!Number.isFinite(warmingCapRemaining) || warmingCapRemaining < 0) return null;
	if (!Number.isFinite(projectedVolume) || projectedVolume < 0) return null;
	if (projectedVolume === 0) return OWN_SHARE_CEILING;
	const ratio = (warmingCapRemaining / projectedVolume) * RAMP_AIMD.capacitySafety;
	if (!Number.isFinite(ratio)) return null;
	return Math.min(OWN_SHARE_CEILING, Math.max(0, ratio));
}

interface DecisionDraft {
	readonly share: number;
	readonly reason: RampDecisionReason;
	readonly verdict: RampDecision['verdict'];
	readonly failedGate?: RampGateId | undefined;
	readonly freezeMs?: number | undefined;
	/** Freeze imposed by a hard stop: it does NOT advance the gate-cooldown ladder. */
	readonly isLadderFreeze?: boolean;
	readonly cleanStreak: number;
	readonly greenSince?: number | undefined;
	/**
	 * The graduation pin to STORE. Every rung sets it explicitly: it is carried
	 * forward by default and REVOKED — set to `undefined` — only by a hard stop or
	 * a breached gate. It is deliberately not derived from the share, because a
	 * graduated cell that the warming cap has bounded below 1.0 has not been
	 * demoted, and re-deriving the pin would make it re-earn fourteen days for a
	 * physical limit it never failed.
	 */
	readonly graduatedAt?: number | undefined;
	/** `now` when this evaluation counted as a window; absent when it did not. */
	readonly countedAt?: number | undefined;
	readonly ceiling: number;
}

/**
 * THE decision. Pure — `now` is a parameter and nothing here reads a clock, a
 * database or the environment.
 */
export function nextShare(input: RampControllerInput): RampDecision {
	const { mix, now } = input;
	const fromShare = roundShare(mix.share);
	const phaseCeiling = normalizePhaseCeiling(mix.phaseCeiling);
	const storedStreak = sanitizeStreak(mix.cleanStreak);
	const isClockUsable = Number.isFinite(now);

	const draft = decide({
		fromShare,
		phaseCeiling,
		storedStreak,
		isClockUsable,
		input,
	});

	const share = roundShare(draft.share);
	const freezeMs = draft.freezeMs;
	const frozenUntil =
		freezeMs === undefined || !isClockUsable ? undefined : now + Math.max(0, freezeMs);
	// The pin is whatever the rung decided. It is NOT re-derived from the share
	// here: a graduated cell bounded below 1.0 by the warming cap is still
	// graduated, while a cell that FAILED its way down had its pin revoked by the
	// rung that lowered it — which is the only place that knows the difference.
	const graduatedAt = draft.graduatedAt;

	return {
		share,
		fromShare,
		reason: draft.reason,
		direction: directionOf(fromShare, share),
		verdict: draft.verdict,
		failedGate: draft.failedGate,
		frozenUntil,
		cooldownMs: draft.isLadderFreeze === true ? freezeMs : undefined,
		cleanStreak: draft.cleanStreak,
		phaseCeiling,
		greenSince: draft.greenSince,
		graduatedAt,
		countedAt: draft.countedAt,
		ceiling: draft.ceiling,
	};
}

interface DecideArgs {
	readonly fromShare: number;
	readonly phaseCeiling: number;
	readonly storedStreak: number;
	readonly isClockUsable: boolean;
	readonly input: RampControllerInput;
}

/**
 * The precedence ladder, in one function on purpose: the ORDER is the safety
 * property, and splitting it across helpers would put the thing a reviewer must
 * verify in three files. Each rung returns; none falls through.
 */
function decide(args: DecideArgs): DecisionDraft {
	const { fromShare, phaseCeiling, storedStreak, isClockUsable, input } = args;
	const { mix, signals, evaluation, capacity, config, now } = input;
	const held = {
		share: fromShare,
		verdict: 'not_evaluated' as const,
		cleanStreak: storedStreak,
		// BOTH carried-forward instants are sanitised on the way through, for the
		// same reason: a DOWNSTREAM reader acts on them — the dashboard and the
		// `mix` blob in `mixDecisions.snapshot` both read the row, not this
		// function — and every rung that returns `held` unchanged (`kill_switch`,
		// `clock_unusable`, `share_unreadable`, `frozen`, the capacity paths) writes
		// them straight back. A row holding NaN, a negative or a future instant
		// would otherwise report the cell as graduated, or as green since some
		// impossible moment, for ever.
		greenSince: readStoredInstant(mix.greenSince, now) ?? undefined,
		graduatedAt: readStoredInstant(mix.graduatedAt, now) ?? undefined,
		ceiling: phaseCeiling,
	};

	// 0. THE GLOBAL KILL SWITCH, before everything including the hard stops. A
	//    paused controller changes nothing in either direction.
	if (input.isKillSwitchEngaged) return { ...held, reason: 'kill_switch' };

	// 1. An unusable clock cannot date a freeze, age evidence or measure a hold.
	if (!isClockUsable) return { ...held, reason: 'clock_unusable' };

	// 2-4. HARD STOPS, in the plan's order. They bypass the gates entirely and
	//      each resets the clean streak AND REVOKES THE GRADUATION PIN: a cell in
	//      one of these states has no clean history left to spend.
	if (!signals.isSendingAllowed) {
		return {
			...held,
			share: 0,
			reason: 'abuse_status',
			cleanStreak: 0,
			greenSince: undefined,
			graduatedAt: undefined,
		};
	}
	if (signals.isCircuitBreakerOpen) {
		// THE FREEZE THIS RUNG STAMPS BINDS THE RUNG ITSELF. An open breaker is a
		// CONDITION, not an event: it stays open across many hourly ticks, and a
		// rung that re-halved on each of them would walk a cell from 0.5 to the
		// rounding floor — and post an incident notice per rung — for ONE incident.
		// The retreat is charged once per freeze window: the cell still hard-stops
		// here every tick (no gate is consulted, streak and pin stay revoked), it
		// just does not re-charge while its own freeze runs. Once that freeze
		// expires with the breaker still open, the next tick halves again.
		if (isFreezeActive(mix, now)) {
			return {
				...held,
				reason: 'breaker',
				cleanStreak: 0,
				greenSince: undefined,
				graduatedAt: undefined,
			};
		}
		return {
			...held,
			share: fromShare * RAMP_AIMD.decreaseFactor,
			reason: 'breaker',
			cleanStreak: 0,
			greenSince: undefined,
			graduatedAt: undefined,
			freezeMs: RAMP_AIMD.breakerFreezeMs,
		};
	}
	if (signals.isPoolBlocklisted) {
		return {
			...held,
			share: 0,
			reason: 'dnsbl',
			cleanStreak: 0,
			greenSince: undefined,
			graduatedAt: undefined,
			freezeMs: RAMP_AIMD.blocklistFreezeMs,
		};
	}

	// 4b. A STORED SHARE THAT IS NOT A SHARE. `clampOwnShare` already pulled it
	//     back into range so nothing downstream can act on garbage, but a row
	//     holding -0.5 or 1.5 or NaN is a row we do not understand, and the one
	//     thing we must not do with a value we do not understand is add to it.
	//     Hold at the clamped value; the hard stops above can still zero it.
	if (!Number.isFinite(mix.share) || mix.share < 0 || mix.share > OWN_SHARE_CEILING) {
		return { ...held, reason: 'share_unreadable' };
	}

	// 5. An unexpired freeze holds, however good the gates look.
	if (isFreezeActive(mix, now)) {
		return { ...held, reason: 'frozen' };
	}

	// 5a. No evaluation at all is thin evidence, not a failure (plan D10). It holds
	// the share and the streak — but it stops the GRADUATION clock, because
	// graduation demands fourteen days of positive evidence and an unmeasured
	// window is not evidence of health. Deferring a pin costs nothing; awarding
	// one to a cell that went quiet costs the relay standby that backs it up.
	if (evaluation === null) return { ...held, reason: 'holding', greenSince: undefined };

	// 5b. EVIDENCE HAS AN EXPIRY. An aggregate stamped long ago — or ahead of the
	//     clock — is not a reading of the present, and a `pass` of any age would
	//     otherwise flow straight through K_CLEAN into the additive-increase
	//     branch and buy one step per elapsed window for ever. Holds in BOTH
	//     directions, and stops the graduation clock, exactly like a missing one:
	//     evidence we cannot date is not evidence (plan D10).
	if (!isEvidenceUsable(evaluation.evaluatedAt, now, config.thresholds)) {
		return { ...held, reason: 'evidence_stale', greenSince: undefined };
	}
	const streak = sanitizeStreak(evaluation.cleanStreak);

	// 6. A breached gate: multiplicative decrease to the floor, then a cooldown.
	if (evaluation.verdict === 'fail' || evaluation.verdict === 'halt') {
		const failedGate = evaluation.failedGate;
		// D17: a tripwire alone is suspect. Hold — the streak is already zero, so
		// holding still forbids an increase; it just does not halve on one signal.
		//
		// NO SECOND CORROBORATION SCAN HERE, deliberately. `aggregateRampGates`
		// names the FIRST gate at the winning rank, so any corroborating fail or
		// halt from a non-tripwire gate would already be `failedGate` and would have
		// left `requiresCorroboration` false. The flag being set therefore already
		// MEANS "the tripwire is alone at the top rank"; re-deriving that from
		// `perGate` would be a predicate that can only ever answer one way.
		if (evaluation.requiresCorroboration) {
			return {
				...held,
				reason: 'awaiting_corroboration',
				verdict: evaluation.verdict,
				failedGate,
				cleanStreak: streak,
				// The window is not green, so the hold clock resets — but the
				// GRADUATION PIN is carried through (`held.graduatedAt`) on purpose.
				// Revoking it here would apply a fourteen-day state penalty on the
				// strength of a signal this very branch has decided not to believe;
				// the pin is revoked only by a hard stop or a gate we DID act on.
				greenSince: undefined,
			};
		}
		// `halt` is a hard stop rather than a step down: it goes straight to the
		// floor. The floor, not zero — a soft failure must keep a trickle so the
		// cell can be re-measured and recover.
		const share =
			evaluation.verdict === 'halt'
				? RAMP_AIMD.shareFloor
				: Math.max(RAMP_AIMD.shareFloor, fromShare * RAMP_AIMD.decreaseFactor);
		return {
			...held,
			share,
			// The union guarantees a named gate on `fail`/`halt`, so this reason can
			// never read `holding` for a halved share (plan D12: no silent retreat).
			reason: failedGate,
			verdict: evaluation.verdict,
			failedGate,
			cleanStreak: streak,
			greenSince: undefined,
			graduatedAt: undefined,
			freezeMs: nextCooldownMs(mix, now),
			isLadderFreeze: true,
		};
	}

	// 7. Thin data HOLDS (plan D10) — the streak is held, not reset. The
	//    graduation clock stops, for the reason given above.
	if (evaluation.verdict !== 'pass') {
		return {
			...held,
			reason: 'holding',
			verdict: evaluation.verdict,
			cleanStreak: streak,
			greenSince: undefined,
		};
	}

	// From here the window is CLEAN. The green clock starts the moment a cell is
	// both at full share and passing; anything else above already cleared it.
	//
	// The STORED instant is sanitised like every other stored field: a green
	// clock in the future is nonsense, and one far enough in the past would hand
	// out a graduation pin on the first passing tick. Unreadable or ahead of the
	// clock ⇒ start counting from now, which can only DELAY a pin.
	//
	// A GRADUATED cell keeps its clock while it sits below 1.0, because the only
	// thing that can put it there is a capacity bound: every gate failure and
	// every hard stop above cleared `graduatedAt` on its way past. Reading the pin
	// off the share alone would revoke a graduation the tick AFTER the warming cap
	// bound it, and the cell would have to climb back at +5pp and re-hold fourteen
	// days for a limit it never failed.
	const isGraduated = readStoredInstant(mix.graduatedAt, now) !== null;
	const greenSince =
		fromShare >= OWN_SHARE_CEILING || isGraduated
			? sanitizeGreenSince(mix.greenSince, now)
			: undefined;
	// A CLEAN WINDOW COUNTS ONCE. The cron ticks hourly against a 24h outcome
	// window, so an ungated streak would reach K_CLEAN in three HOURS off three
	// overlapping reads of the same day. Only a counted window extends the streak
	// or unlocks an increase; between counts the cell holds exactly where it is.
	const isWindowCounted = isEvaluationWindowElapsed(mix.lastCountedAt, now);
	const countedStreak = isWindowCounted ? streak : storedStreak;
	const green = {
		...held,
		verdict: 'pass' as const,
		cleanStreak: countedStreak,
		greenSince,
		countedAt: isWindowCounted ? now : undefined,
	};

	// 8. CAPACITY CEILING. Unusable projection holds; it never becomes "no limit".
	//    Computed BEFORE graduation on purpose: a pinned cell is the cell carrying
	//    the most volume, so exempting it from the warming cap would exempt exactly
	//    the wrong one.
	const capacityBound = capacityCeiling(capacity);
	if (capacityBound === null) return { ...green, reason: 'capacity_unknown' };
	const ceiling = Math.min(OWN_SHARE_CEILING, capacityBound, phaseCeiling);
	const bindingReason: RampDecisionReason =
		capacityBound < phaseCeiling ? 'capacity_ceiling' : 'phase_ceiling';

	// GRADUATION (plan D9): s = 1.0 held 14 days, all gates green. The cell PINS
	// and the relay drops to priority_failover standby.
	//
	// The PIN SURVIVES A CAPACITY BOUND but does not override it: a graduated cell
	// still gives way to the warming cap, and when it does the sentence names the
	// ceiling rather than claiming a graduation move the operator did not see.
	const isGraduationDue =
		greenSince !== undefined && now - greenSince >= RAMP_AIMD.graduationHoldMs;
	// The pin is AWARDED here and carried by every rung below, so a graduated cell
	// that has to climb back to its ceiling stays graduated the whole way up.
	const pinnedGreen = isGraduationDue
		? { ...green, graduatedAt: readStoredInstant(mix.graduatedAt, now) ?? now }
		: green;

	if (isGraduationDue) {
		// The pinned target is the ceiling — but NEVER below the soft floor. A
		// capacity ceiling is not a breach, and this module allows only a gate
		// failure or a hard stop to take a cell to zero; a warming cap with no
		// headroom left projects a ceiling of 0, and honouring that literally would
		// switch a healthy graduated cell off entirely.
		// Rounded to the stored precision before it is COMPARED to `fromShare`,
		// which is already rounded: a ceiling one float ulp above the current share
		// is not a restore anyone asked for, and comparing raw against rounded would
		// route it through the increase rungs to land back on the same number.
		const pinTarget = roundShare(
			Math.max(RAMP_AIMD.shareFloor, Math.min(OWN_SHARE_CEILING, ceiling))
		);
		// THIS RUNG MAY ONLY HOLD OR LOWER. Retreating to a bound is instant and
		// costs nothing; RESTORING is an increase, and every increase in this module
		// is paid for in the same currency — K_CLEAN, one counted window, one step —
		// so an upward pin target falls through to rungs 10 and 11 rather than
		// jumping the cell to its ceiling in a single evaluation.
		if (pinTarget < fromShare) {
			return { ...pinnedGreen, share: pinTarget, reason: bindingReason, ceiling };
		}
		if (pinTarget === fromShare) {
			return { ...pinnedGreen, share: pinTarget, reason: 'graduated', ceiling };
		}
	}

	// 10. K_CLEAN. Confidence is spent, not assumed — and it is spent in WINDOWS,
	//     so the streak read here is the one this window is allowed to have moved.
	if (countedStreak < config.cleanWindowsRequired) {
		return { ...pinnedGreen, reason: 'building_confidence', ceiling };
	}

	// 11. ADDITIVE INCREASE — the ONLY branch that can raise a share, and at most
	//     ONCE PER EVALUATION WINDOW. A ceiling pull-back below is deliberately
	//     NOT window-gated: retreats stay instant, advances stay expensive.
	const step: number = ppToFraction(config.increaseStep);
	const bounded = Math.min(ceiling, fromShare + step);
	if (bounded > fromShare) {
		if (!isWindowCounted) return { ...pinnedGreen, reason: 'window_open', ceiling };
		return { ...pinnedGreen, share: bounded, reason: 'healthy', ceiling };
	}
	// A CEILING IS NOT A BREACH. When the ceiling sits below the current share it
	// pulls the cell back to it, but never below the soft floor: nothing here
	// measured anything wrong, and only a gate failure or a hard stop may take a
	// cell to zero. Keeping the trickle is what lets the cell be re-measured.
	// `Math.min(fromShare, ...)` keeps this branch incapable of raising anything:
	// the floor may only ever soften a retreat, never become an increase in
	// disguise for a cell sitting below it.
	const target = Math.min(fromShare, Math.max(RAMP_AIMD.shareFloor, bounded));
	return { ...pinnedGreen, share: target, reason: bindingReason, ceiling };
}
