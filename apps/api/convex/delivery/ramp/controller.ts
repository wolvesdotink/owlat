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
 *   5. active freeze        -> hold
 *   6. gate halt / fail     -> max(floor, s x 0.5), freeze COOLDOWN
 *   7. insufficient data    -> hold (plan D10: never up, and never DOWN either)
 *   8. capacity ceiling
 *   9. K_CLEAN              -> hold while building confidence
 *  10. additive increase    -> min(ceiling, s + step)
 *
 * Every rule above 8 either HOLDS or LOWERS the share. An increase is reachable
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

import { clampOwnShare, OWN_SHARE_CEILING } from '@owlat/shared/deliverabilityRouting';
import { normalizePhaseCeiling, RAMP_AIMD } from './controllerConfig';
import { CORROBORATION_REQUIRED_RAMP_GATES, ppToFraction } from './gateConfig';
import type { RampGateEvaluation, RampGateId } from './gateTypes';
import type {
	RampCapacityInput,
	RampControllerInput,
	RampDecision,
	RampDecisionDirection,
	RampDecisionReason,
	RampMixState,
} from './controllerTypes';

/**
 * Shares are stored to four decimals. Repeated additive increase on binary
 * floats drifts (0.02 + 0.05 x 19 lands on 0.9699999999999999), and a drifting
 * share makes every fixture approximate and every audit row unreadable.
 */
const SHARE_PRECISION = 10_000;

function roundShare(value: number): number {
	return Math.round(clampOwnShare(value) * SHARE_PRECISION) / SHARE_PRECISION;
}

function sanitizeStreak(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

function directionOf(fromShare: number, share: number): RampDecisionDirection {
	if (share > fromShare) return 'increase';
	if (share < fromShare) return 'decrease';
	return 'hold';
}

/**
 * The cooldown ladder (plan D9): 6h, DOUBLING when the breach repeats within
 * 24h of the previous freeze's start, capped at 48h.
 *
 * A missing, corrupt or non-positive stored ladder position restarts at the
 * base rather than propagating garbage — the ladder is a penalty, and a penalty
 * derived from an unreadable number is not a penalty anyone can defend.
 */
export function nextCooldownMs(mix: RampMixState, now: number): number {
	const { cooldownBaseMs, cooldownMaxMs, cooldownRepeatWindowMs } = RAMP_AIMD;
	const startedAt = mix.freezeStartedAt;
	const isRepeat =
		startedAt !== undefined &&
		Number.isFinite(startedAt) &&
		now >= startedAt &&
		now - startedAt < cooldownRepeatWindowMs;
	const previous = mix.cooldownMs;
	if (!isRepeat || previous === undefined || !Number.isFinite(previous) || previous <= 0) {
		return cooldownBaseMs;
	}
	return Math.min(cooldownMaxMs, previous * 2);
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
	const { warmingCapRemaining, projectedVolume } = capacity;
	if (!Number.isFinite(warmingCapRemaining) || warmingCapRemaining < 0) return null;
	if (!Number.isFinite(projectedVolume) || projectedVolume < 0) return null;
	if (projectedVolume === 0) return OWN_SHARE_CEILING;
	const ratio = (warmingCapRemaining / projectedVolume) * RAMP_AIMD.capacitySafety;
	if (!Number.isFinite(ratio)) return null;
	return Math.min(OWN_SHARE_CEILING, Math.max(0, ratio));
}

/**
 * Does a tripwire failure have corroboration (plan D17)? Seeds are 5-10
 * mailboxes: a collapse across all of them is actionable at any sample size but
 * SUSPECT on its own, so the deferral or bounce gate must agree before the
 * share is halved. Without agreement the controller HOLDS — it does not
 * increase either, because the streak was already reset by the failure.
 */
function isCorroborated(evaluation: RampGateEvaluation): boolean {
	return evaluation.perGate.some(
		(result) =>
			!CORROBORATION_REQUIRED_RAMP_GATES.has(result.gate) &&
			(result.status === 'fail' || result.status === 'halt')
	);
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
	readonly graduatedAt?: number | undefined;
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
	// A share that left 1.0 is no longer graduated, whatever the row says: the
	// pin is a property of the share, not a badge the row keeps forever.
	const graduatedAt =
		share >= OWN_SHARE_CEILING ? (draft.graduatedAt ?? mix.graduatedAt) : undefined;

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
		greenSince: mix.greenSince,
		graduatedAt: mix.graduatedAt,
		ceiling: phaseCeiling,
	};

	// 0. THE GLOBAL KILL SWITCH, before everything including the hard stops. A
	//    paused controller changes nothing in either direction.
	if (input.isKillSwitchEngaged) return { ...held, reason: 'kill_switch' };

	// 1. An unusable clock cannot date a freeze, age evidence or measure a hold.
	if (!isClockUsable) return { ...held, reason: 'clock_unusable' };

	// 2-4. HARD STOPS, in the plan's order. They bypass the gates entirely and
	//      each resets the clean streak: a cell in one of these states has no
	//      clean history to spend.
	if (!signals.isSendingAllowed) {
		return { ...held, share: 0, reason: 'abuse_status', cleanStreak: 0, greenSince: undefined };
	}
	if (signals.isCircuitBreakerOpen) {
		return {
			...held,
			share: fromShare * RAMP_AIMD.decreaseFactor,
			reason: 'breaker',
			cleanStreak: 0,
			greenSince: undefined,
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
	if (mix.frozenUntil !== undefined && Number.isFinite(mix.frozenUntil) && now < mix.frozenUntil) {
		return { ...held, reason: 'frozen' };
	}

	// No evaluation at all is thin evidence, not a failure (plan D10). It holds
	// the share and the streak — but it stops the GRADUATION clock, because
	// graduation demands fourteen days of positive evidence and an unmeasured
	// window is not evidence of health. Deferring a pin costs nothing; awarding
	// one to a cell that went quiet costs the relay standby that backs it up.
	if (evaluation === null) return { ...held, reason: 'holding', greenSince: undefined };
	const streak = sanitizeStreak(evaluation.cleanStreak);

	// 6. A breached gate: multiplicative decrease to the floor, then a cooldown.
	if (evaluation.verdict === 'fail' || evaluation.verdict === 'halt') {
		const failedGate = evaluation.failedGate;
		// D17: a tripwire alone is suspect. Hold — the streak is already zero, so
		// holding still forbids an increase; it just does not halve on one signal.
		if (evaluation.requiresCorroboration && !isCorroborated(evaluation)) {
			return {
				...held,
				reason: 'awaiting_corroboration',
				verdict: evaluation.verdict,
				failedGate,
				cleanStreak: streak,
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
			reason: failedGate ?? 'holding',
			verdict: evaluation.verdict,
			failedGate,
			cleanStreak: streak,
			greenSince: undefined,
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
	const greenSince = fromShare >= OWN_SHARE_CEILING ? (mix.greenSince ?? now) : undefined;
	const green = { ...held, verdict: 'pass' as const, cleanStreak: streak, greenSince };

	// GRADUATION (plan D9): s = 1.0 held 14 days, all gates green. The cell PINS
	// and the relay drops to priority_failover standby.
	if (
		greenSince !== undefined &&
		Number.isFinite(greenSince) &&
		now - greenSince >= RAMP_AIMD.graduationHoldMs
	) {
		return {
			...green,
			share: OWN_SHARE_CEILING,
			reason: 'graduated',
			graduatedAt: mix.graduatedAt ?? now,
			ceiling: OWN_SHARE_CEILING,
		};
	}

	// 8. CAPACITY CEILING. Unusable projection holds; it never becomes "no limit".
	const capacityBound = capacityCeiling(capacity);
	if (capacityBound === null) return { ...green, reason: 'capacity_unknown' };
	const ceiling = Math.min(OWN_SHARE_CEILING, capacityBound, phaseCeiling);
	const bindingReason: RampDecisionReason =
		capacityBound < phaseCeiling ? 'capacity_ceiling' : 'phase_ceiling';

	// 9. K_CLEAN. Confidence is spent, not assumed.
	if (streak < config.cleanWindowsRequired) {
		return { ...green, reason: 'building_confidence', ceiling };
	}

	// 10. ADDITIVE INCREASE — the ONLY branch that can raise a share.
	const step: number = ppToFraction(config.increaseStep);
	const target = Math.min(ceiling, fromShare + step);
	if (target > fromShare) return { ...green, share: target, reason: 'healthy', ceiling };
	return { ...green, share: target, reason: bindingReason, ceiling };
}
