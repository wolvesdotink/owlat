/**
 * THE PACE ACTUATOR — the standalone twin of `nextShare` (plan D3, D9, D19).
 *
 * With no reference transport there is no mix to control (s === 1 by
 * definition), but the controller was never really about transport share: it is
 * about how fast we let volume grow against measured evidence. So the controller
 * stays and the ACTUATOR is swapped — the controlled variable becomes a growth
 * MULTIPLIER on the per-(IP x mailboxProvider) daily cap. Same gates, same AIMD
 * arithmetic (`aimd.ts`, shared with the share actuator), same guardrails, same
 * freeze ladder.
 *
 * THE PRECEDENCE LADDER IS `nextShare`'S, rung for rung, because the two
 * actuators answer the same questions in the same order and a reader who has
 * verified one should recognise the other:
 *
 *   0. kill switch            — pin, in BOTH directions
 *   1. unusable clock         — never decide against a broken clock
 *   2. abuse status           -> M_MIN
 *   3. circuit breaker        -> m x 0.5, freeze 6h (charged once per incident)
 *   4. critical blocklist     -> M_MIN, freeze 24h (trailing, re-stamped)
 *  4b. unreadable multiplier  -> hold at the clamped value
 *   5. active freeze          -> hold
 *  5a. no evaluation at all   -> hold
 *  5b. stale/skewed evidence  -> hold
 *   6. gate halt / fail       -> max(M_MIN, m x 0.5), freeze COOLDOWN
 *   7. insufficient data      -> hold (plan D10: never up, and never DOWN either)
 *   8. day already advanced   -> hold  (THE PRESERVED PER-UTC-DAY GUARD, D19)
 *   9. low utilisation        -> hold  (THE ONE SANCTIONED CHANGE, D19)
 *  10. K_CLEAN                -> hold while building confidence
 *  11. additive increase      -> min(M_MAX, m + STEP), at most once per UTC day
 *
 * TWO SHIPPED PROPERTIES ARE PRESERVED EXACTLY (plan D19).
 *
 * (1) THE PER-UTC-DAY IDEMPOTENCY GUARD. The controller ticks hourly; a warming
 *     schedule must advance AT MOST ONCE per UTC day, or a clean deployment
 *     walks the whole published ramp in ~30 hours. Rung 8 is that guard, and it
 *     is written the way the shipped MTA evaluator writes it — comparing a
 *     stored `YYYY-MM-DD` day key — so the two guards mean the same thing.
 *     RETREATS ARE NOT GATED BY IT: rungs 2, 3, 4 and 6 all sit above it, so a
 *     breach halves the multiplier the moment it is seen, however many times the
 *     day has already been counted. Cheap to retreat, expensive to advance.
 *
 * (2) THE BASE SCHEDULE IS A HARD CEILING. Nothing here can exceed it because
 *     nothing here computes a cap: the multiplier is a dial, and
 *     `effectiveDailyCap` (paceCeiling.ts) is the one place a cap is produced
 *     and the one place the day's published ceiling is applied.
 *
 * THE ONE SANCTIONED BEHAVIOUR CHANGE, fixture-pinned in
 * `paceUtilisationChange.test.ts`: the shipped evaluator requires >= 80% cap
 * utilisation to ACCELERATE and otherwise falls through to the normal one-day
 * advance — so a deployment sending less than its cap can never accelerate and
 * only ever advances one day at a time. Under pace control the same reading is
 * INSUFFICIENT EVIDENCE and the actuator HOLDS: an unexercised cap is not
 * evidence of anything, and the day is deliberately left UNCOUNTED so a later
 * tick — once the volume arrives — can still evaluate it once.
 *
 * PURE (plan D15): no `Date.now()`, no database, no environment. `now` is a
 * parameter.
 */

import { aimdClamp, aimdDecrease, aimdIncrease } from './aimd';
import { utcDayKey } from '../../lib/utcDay';
import { nextCooldownMs, RAMP_AIMD, RAMP_MAX_FREEZE_MS } from './controllerConfig';
import {
	extendFreezeUntil,
	isEvidenceUsable,
	readActiveFreeze,
	sanitizeStreak,
} from './controllerReaders';
import { rampDecisionDirection } from './controllerTypes';
import { PACE_AIMD } from './paceConfig';
import type {
	PaceControllerInput,
	PaceDecision,
	PaceDecisionDraft,
	PaceUtilisationReading,
} from './paceTypes';

/** Stored multipliers are kept to three decimals, like the stored share. */
export function roundMultiplier(value: number): number {
	if (!Number.isFinite(value)) return PACE_AIMD.multiplierFloor;
	return Math.round(value * 1000) / 1000;
}

/** Is the stored multiplier a multiplier at all? */
export function isStoredMultiplierReadable(stored: number): boolean {
	return (
		Number.isFinite(stored) &&
		stored >= PACE_AIMD.multiplierFloor &&
		stored <= PACE_AIMD.multiplierCeiling
	);
}

/**
 * IS THE CAP BEING EXERCISED ENOUGH FOR THE WINDOW TO MEAN ANYTHING?
 *
 * `unknown` answers NO, and a non-finite or non-positive enforced cap answers NO
 * as well: `sent / 0` is the division the whole degenerate rule exists to
 * forbid, and an unreadable ratio must never be the thing that buys a step.
 */
export function isCapExercised(reading: PaceUtilisationReading): boolean {
	if (reading.kind === 'unknown') return false;
	const { sent, enforcedCap } = reading;
	if (!Number.isFinite(enforcedCap) || enforcedCap <= 0) return false;
	if (!Number.isFinite(sent) || sent <= 0) return false;
	return sent / enforcedCap >= PACE_AIMD.minimumUtilisation;
}

/** THE decision. Pure — `now` is a parameter. */
export function nextPaceMultiplier(input: PaceControllerInput): PaceDecision {
	const { pace, now } = input;
	const fromMultiplier = roundMultiplier(
		aimdClamp(pace.multiplier, PACE_AIMD.multiplierFloor, PACE_AIMD.multiplierCeiling)
	);
	const storedStreak = sanitizeStreak(pace.cleanStreak);
	const isClockUsable = Number.isFinite(now);

	const draft = decide({ fromMultiplier, storedStreak, isClockUsable, input });

	const multiplier = roundMultiplier(
		aimdClamp(draft.multiplier, PACE_AIMD.multiplierFloor, PACE_AIMD.multiplierCeiling)
	);
	const freezeMs = draft.freezeMs;
	// A FREEZE IS ONLY EVER LENGTHENED — the share actuator's rule and its
	// implementation, so a 6h breaker stop can never cut a 48h gate cooldown short.
	const frozenUntil =
		freezeMs === undefined || !isClockUsable
			? undefined
			: extendFreezeUntil(now + Math.max(0, freezeMs), pace, now, RAMP_MAX_FREEZE_MS);

	return {
		multiplier,
		fromMultiplier,
		reason: draft.reason,
		direction: rampDecisionDirection(fromMultiplier, multiplier),
		verdict: draft.verdict,
		failedGate: draft.failedGate,
		freeze:
			frozenUntil === undefined || draft.freezeReason === undefined
				? undefined
				: {
						until: frozenUntil,
						origin: draft.freezeReason,
						...(draft.isLadderFreeze === true ? { ladderMs: freezeMs } : {}),
					},
		cleanStreak: draft.cleanStreak,
		countedUtcDay: draft.countedUtcDay,
	};
}

interface PaceDecideArgs {
	readonly fromMultiplier: number;
	readonly storedStreak: number;
	readonly isClockUsable: boolean;
	readonly input: PaceControllerInput;
}

/**
 * The precedence ladder, in one function on purpose — the ORDER is the safety
 * property, and it is the property the reviewer of this piece reads first.
 */
function decide(args: PaceDecideArgs): PaceDecisionDraft {
	const { fromMultiplier, storedStreak, isClockUsable, input } = args;
	const { pace, signals, evaluation, config, utilisation, now } = input;
	const held = {
		multiplier: fromMultiplier,
		verdict: 'not_evaluated' as const,
		cleanStreak: storedStreak,
	};

	// 0. THE GLOBAL KILL SWITCH, before everything including the hard stops.
	if (input.isKillSwitchEngaged) return { ...held, reason: 'kill_switch' };

	// 1. An unusable clock cannot date a freeze, age evidence or name a UTC day.
	if (!isClockUsable) return { ...held, reason: 'clock_unusable' };

	// 2-4. HARD STOPS, in the share actuator's order and with its freeze policies.
	//      Each resets the clean streak: a cell in one of these states has no
	//      clean history left to spend.
	//
	// 2. ABUSE STATUS — no freeze at all. The condition itself is the hold and it
	//    is re-read every tick, so it lifts the instant the account is reinstated.
	//    The dial goes to M_MIN rather than to zero: a cap of nothing can never be
	//    re-measured, and abuse status already stops the sends themselves.
	if (!signals.isSendingAllowed) {
		return {
			...held,
			multiplier: PACE_AIMD.multiplierFloor,
			reason: 'abuse_status',
			cleanStreak: 0,
		};
	}
	// 3. CIRCUIT BREAKER — the retreat is charged ONCE per breaker freeze window.
	//    An open breaker is a CONDITION that persists across many hourly ticks,
	//    and re-halving on each of them would walk a cell to the floor for ONE
	//    incident. The ORIGIN test is what stops an unrelated 48h gate cooldown
	//    absorbing the halving a newly-open breaker is supposed to cost.
	if (signals.isCircuitBreakerOpen) {
		const freeze = readActiveFreeze(pace, now, RAMP_MAX_FREEZE_MS);
		if (freeze.kind === 'active' && freeze.origin === 'breaker') {
			return { ...held, reason: 'breaker', cleanStreak: 0 };
		}
		return {
			...held,
			multiplier: aimdDecrease(fromMultiplier, {
				floor: PACE_AIMD.multiplierFloor,
				decreaseFactor: PACE_AIMD.decreaseFactor,
			}),
			reason: 'breaker',
			cleanStreak: 0,
			freezeMs: RAMP_AIMD.breakerFreezeMs,
			freezeReason: 'breaker',
		};
	}
	// 4. CRITICAL BLOCKLIST — freeze RE-STAMPED every tick, deliberately unlike
	//    the breaker: the dial is already at the floor so there is no retreat to
	//    re-charge, and what the re-stamp buys is a TRAILING 24h after the last
	//    tick that still saw the listing.
	if (signals.isPoolBlocklisted) {
		return {
			...held,
			multiplier: PACE_AIMD.multiplierFloor,
			reason: 'dnsbl',
			cleanStreak: 0,
			freezeMs: RAMP_AIMD.blocklistFreezeMs,
			freezeReason: 'dnsbl',
		};
	}

	// 4b. A STORED MULTIPLIER THAT IS NOT ONE. Already clamped so nothing
	//     downstream acts on garbage — but the one thing we must not do with a
	//     value we do not understand is add to it.
	if (!isStoredMultiplierReadable(pace.multiplier)) {
		return { ...held, reason: 'multiplier_unreadable' };
	}

	// 5. An unexpired freeze holds, whoever stamped it; an UNREADABLE one holds
	//    too, under its own reason — a freeze we cannot read is not permission to
	//    step up.
	const storedFreeze = readActiveFreeze(pace, now, RAMP_MAX_FREEZE_MS);
	if (storedFreeze.kind === 'active') return { ...held, reason: 'frozen' };
	if (storedFreeze.kind === 'unreadable') return { ...held, reason: 'freeze_unreadable' };

	// 5a. No evaluation at all is thin evidence, not a failure (plan D10).
	if (evaluation === null) return { ...held, reason: 'holding' };

	// 5b. EVIDENCE HAS AN EXPIRY, in both directions: a `pass` of any age would
	//     otherwise buy one step per elapsed day for ever.
	if (!isEvidenceUsable(evaluation.evaluatedAt, now, config.thresholds)) {
		return { ...held, reason: 'evidence_stale' };
	}
	const streak = sanitizeStreak(evaluation.cleanStreak);

	// 6. A breached gate: multiplicative decrease to M_MIN, then a cooldown.
	//    ABOVE the per-day guard on purpose — a retreat is never rationed.
	if (evaluation.verdict === 'fail' || evaluation.verdict === 'halt') {
		const failedGate = evaluation.failedGate;
		// D17: a tripwire alone is suspect. Hold — the streak is already zero, so
		// holding still forbids an increase; it just does not halve on one signal.
		if (evaluation.requiresCorroboration) {
			return {
				...held,
				reason: 'awaiting_corroboration',
				verdict: evaluation.verdict,
				failedGate,
				cleanStreak: streak,
			};
		}
		// `halt` goes straight to the floor; `fail` halves to it. The floor, not
		// zero — a soft failure keeps a trickle so the cell can be re-measured.
		const multiplier =
			evaluation.verdict === 'halt'
				? PACE_AIMD.multiplierFloor
				: aimdDecrease(fromMultiplier, {
						floor: PACE_AIMD.multiplierFloor,
						decreaseFactor: PACE_AIMD.decreaseFactor,
					});
		return {
			...held,
			multiplier,
			reason: failedGate,
			verdict: evaluation.verdict,
			failedGate,
			cleanStreak: streak,
			freezeMs: nextCooldownMs(pace, now),
			freezeReason: 'gate_breach',
			isLadderFreeze: true,
		};
	}

	// 7. Thin data HOLDS (plan D10) — the streak is held, not reset.
	if (evaluation.verdict !== 'pass') {
		return { ...held, reason: 'holding', verdict: evaluation.verdict, cleanStreak: streak };
	}

	// From here the window is CLEAN.
	const green = { ...held, verdict: 'pass' as const };
	const today = utcDayKey(now);

	// 8. THE PER-UTC-DAY IDEMPOTENCY GUARD (plan D19), PRESERVED. Twenty-four
	//    hourly ticks in one UTC day advance the schedule exactly once. The empty
	//    key is never a match: an unusable clock is rung 1's business, and a stored
	//    day nobody set must not be able to look like today.
	if (today !== '' && today === pace.lastEvaluatedUtcDay) {
		return { ...green, reason: 'day_already_advanced' };
	}

	// 9. THE ONE SANCTIONED BEHAVIOUR CHANGE (plan D19). An unexercised cap is not
	//    evidence, so this HOLDS where the shipped evaluator advanced anyway — and
	//    it deliberately leaves the day UNCOUNTED, exactly as the shipped
	//    evaluator leaves its guard unset on a day with no sends, so a later tick
	//    once the volume arrives can still evaluate this day once.
	if (!isCapExercised(utilisation)) {
		return { ...green, reason: 'low_utilisation' };
	}

	// The day COUNTS from here: the evidence was real and sufficient.
	const counted = { ...green, cleanStreak: streak, countedUtcDay: today };

	// 10. K_CLEAN. Confidence is spent, not assumed.
	if (streak < config.cleanWindowsRequired) {
		return { ...counted, reason: 'building_confidence' };
	}

	// 11. ADDITIVE INCREASE — the ONLY branch that can raise the multiplier, and
	//     at most once per UTC day by the guard at rung 8.
	const bounded = aimdIncrease(fromMultiplier, {
		ceiling: PACE_AIMD.multiplierCeiling,
		step: PACE_AIMD.increaseStep,
	});
	if (bounded > fromMultiplier) return { ...counted, multiplier: bounded, reason: 'healthy' };
	// Already at M_MAX. The published schedule is what limits the cap from here.
	return { ...counted, reason: 'schedule_ceiling' };
}
