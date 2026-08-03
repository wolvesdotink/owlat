/**
 * The AIMD controller's constants (plan D9).
 *
 * THE ASYMMETRY IS THE WHOLE POINT: cheap to retreat, expensive to advance. An
 * increase costs three consecutive clean windows and moves a few percentage
 * points; a decrease costs one breached gate and halves the share instantly.
 * Every number below exists to keep that asymmetry, so changing one in
 * isolation — a smaller cooldown, a bigger step — is a change to the safety
 * property, not a tuning tweak.
 *
 * The PER-STREAM numbers (initial share, step, K_CLEAN) live in `gateConfig.ts`
 * as `RAMP_STREAM_CONFIGS` and are reused here rather than re-declared: one
 * table of ramp constants, not two that can disagree.
 *
 * `nextCooldownMs` lives here rather than beside the row readers because it is
 * POLICY, not a reading: it owns the ladder's doubling rule and every number it
 * returns comes off `RAMP_AIMD`. It reads one stored instant on the way, which
 * is why it borrows `readStoredInstant` — the dependency runs one way only
 * (readers never import this module's constants).
 */

import { readStoredInstant } from './controllerReaders';

/**
 * THE COOLDOWN LADDER'S INPUTS, and nothing else.
 *
 * Narrowed from `RampMixState` deliberately: BOTH actuators climb the same
 * ladder (plan D3 — one controller, two actuators), and the pace actuator's
 * stored state is not a mix state. Taking the two fields the rule actually
 * reads is what lets the ladder stay one function instead of two copies that
 * can drift apart. `RampMixState` and `PaceState` both satisfy it structurally.
 */
export interface RampCooldownState {
	/**
	 * The instant the previous LADDER freeze started. With `cooldownMs` it is what
	 * dates that freeze's EXPIRY, which is where the repeat window runs from — see
	 * `nextCooldownMs`. Only a ladder freeze stamps it (`resolveFreezeFields`), so
	 * a breaker or blocklist stop cannot re-arm the window.
	 */
	readonly freezeStartedAt: number | undefined;
	/** The cooldown length that produced the current freeze (the ladder position). */
	readonly cooldownMs: number | undefined;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface RampAimdConfig {
	/** Multiplicative decrease applied the instant any gate breaches. */
	readonly decreaseFactor: number;
	/**
	 * The share a SOFT failure may never fall below. Never fully zero: a cell at
	 * zero sends nothing, and a cell that sends nothing can never be re-measured,
	 * so it could never recover. A HARD stop (abuse status, critical blocklist)
	 * deliberately ignores this floor — that is what makes it hard.
	 */
	readonly shareFloor: number;
	/** First cooldown after a gate breach. */
	readonly cooldownBaseMs: number;
	/** Cooldown ceiling. Doubling stops here. */
	readonly cooldownMaxMs: number;
	/**
	 * HOW LONG A CELL MUST RUN CLEAN, AFTER ITS LAST COOLDOWN ENDED, to be
	 * forgiven. A breach inside this long of the previous freeze's EXPIRY is a
	 * REPEAT and doubles the cooldown; a breach after it starts again from the
	 * base. The shape mirrors the shipped MTA circuit breaker so an operator only
	 * has one back-off model to hold in their head.
	 *
	 * MEASURED FROM THE EXPIRY, NOT THE START, and the whole ladder depends on it:
	 * a freeze lasts exactly its rung and the `frozen` rung forbids re-evaluation
	 * while it runs, so the earliest breach after a 24h cooldown is 24h after its
	 * START — never a repeat under a start-anchored window. Anchored there, the
	 * production ladder cycled 6h/12h/24h/base for ever and `cooldownMaxMs` was
	 * unreachable: the penalty stopped growing exactly where the plan says it
	 * should double.
	 */
	readonly cooldownRepeatWindowMs: number;
	/** Freeze after the MTA circuit breaker opens for the cell. */
	readonly breakerFreezeMs: number;
	/** Freeze after a critical pool blocklist listing. */
	readonly blocklistFreezeMs: number;
	/**
	 * Headroom multiplier on the capacity ceiling: never plan to fill more than
	 * this much of the remaining warming cap, because the projection is a
	 * projection.
	 */
	readonly capacitySafety: number;
	/** How long s = 1.0 must hold, all gates green, before the cell graduates. */
	readonly graduationHoldMs: number;
	/**
	 * THE LENGTH OF ONE EVALUATION WINDOW, and therefore the minimum spacing
	 * between two COUNTED clean windows.
	 *
	 * The cron ticks hourly; the gates read a 24h window of outcomes. Without this
	 * constant, K_CLEAN = 3 would be satisfied by three overlapping reads of the
	 * SAME day taken an hour apart, and a green cell could take ~20 additive steps
	 * from 0.02 to its phase ceiling inside a single day — which is precisely the
	 * "expensive to advance" half of D9's asymmetry deleted. A window counts only
	 * once, and only a counted window extends the streak or permits an increase.
	 *
	 * It is ONE number for both the gate query and the streak spacing on purpose:
	 * two would be able to disagree about what "a window" means.
	 */
	readonly evaluationWindowMs: number;
}

export const RAMP_AIMD: RampAimdConfig = {
	decreaseFactor: 0.5,
	shareFloor: 0.01,
	cooldownBaseMs: 6 * HOUR_MS,
	cooldownMaxMs: 48 * HOUR_MS,
	cooldownRepeatWindowMs: 24 * HOUR_MS,
	breakerFreezeMs: 6 * HOUR_MS,
	blocklistFreezeMs: 24 * HOUR_MS,
	capacitySafety: 0.8,
	graduationHoldMs: 14 * DAY_MS,
	evaluationWindowMs: DAY_MS,
};

/**
 * THE LONGEST FREEZE ANY RUNG CAN LEGITIMATELY STAMP, and therefore the
 * plausibility bound on a stored `frozenUntil`.
 *
 * Derived rather than written down: the three freezing rungs are the gate
 * cooldown ladder (capped at `cooldownMaxMs`), the breaker and the blocklist, so
 * a stored expiry further out than the largest of those did not come from this
 * controller. It exists because `frozenUntil` is state a corrupt write or a
 * skewed clock can put arbitrarily far in the future, and a freeze nobody can
 * outlive would pin a cell — and suppress the breaker rung's retreat — for ever.
 */
export const RAMP_MAX_FREEZE_MS: number = Math.max(
	RAMP_AIMD.cooldownMaxMs,
	RAMP_AIMD.breakerFreezeMs,
	RAMP_AIMD.blocklistFreezeMs
);

/**
 * The cooldown ladder (plan D9): 6h, DOUBLING when the breach repeats within 24h
 * of the previous freeze's EXPIRY, capped at 48h.
 *
 * THE ANCHOR IS THE EXPIRY, AND THAT IS THE WHOLE RULE. A ladder freeze lasts
 * exactly its own rung and the `frozen` rung refuses to evaluate a cell while it
 * runs, so the earliest breach that can follow a 24h cooldown is 24h after that
 * cooldown STARTED. Measured from the start, the 24h window was therefore
 * unreachable from the 24h rung: the ladder cycled 6h, 12h, 24h, base for ever
 * and no cell could be handed the 48h cap the plan tops it out at. Measured from
 * the expiry it asks the question the constant is named for — has this cell run
 * clean for a day since we last let it go?
 *
 * The expiry is derived (`freezeStartedAt + cooldownMs`) rather than stored: the
 * two columns already move together as one fact (`resolveFreezeFields`), and a
 * third column carrying what they imply would be a third thing to keep in step.
 * `frozenUntil` is deliberately NOT that expiry — a hard stop can extend it
 * (`extendFreezeUntil`), and an infrastructure incident must not lengthen the
 * gate ladder's window any more than it may re-arm it.
 *
 * A missing, corrupt or non-positive stored ladder position restarts at the
 * base rather than propagating garbage — the ladder is a penalty, and a penalty
 * derived from an unreadable number is not a penalty anyone can defend. A rung
 * ABOVE the cap is read as the cap for the same reason, in both places it is
 * used: no rung this controller stamps can exceed it, so believing a larger one
 * would push the forgiveness window out by hours nobody imposed.
 */
export function nextCooldownMs(state: RampCooldownState, now: number): number {
	const { cooldownBaseMs, cooldownMaxMs, cooldownRepeatWindowMs } = RAMP_AIMD;
	const previous = state.cooldownMs;
	if (previous === undefined || !Number.isFinite(previous) || previous <= 0) return cooldownBaseMs;
	const startedAt = readStoredInstant(state.freezeStartedAt, now);
	if (startedAt === null) return cooldownBaseMs;
	const rung = Math.min(previous, cooldownMaxMs);
	const endedAt = startedAt + rung;
	if (now - endedAt >= cooldownRepeatWindowMs) return cooldownBaseMs;
	return Math.min(cooldownMaxMs, rung * 2);
}

/**
 * The phase ceiling ladder. A cell may not exceed its current rung however
 * clean its gates are; promotion between rungs is a separate, deliberate act
 * (manual or criteria-gated) rather than something the hourly AIMD loop does on
 * its own — that is the point of having a ladder at all.
 *
 * EXPORTED so a fixture can assert that the ceiling it passes is a real rung:
 * `normalizePhaseCeiling` snaps anything else onto the lowest one, which is a
 * silent way for a test to stop testing the branch it names.
 */
export const RAMP_PHASE_CEILINGS = [0.25, 0.5, 0.8, 1] as const;

export const RAMP_INITIAL_PHASE_CEILING: number = RAMP_PHASE_CEILINGS[0];

/**
 * Snap a stored ceiling onto the ladder, rounding DOWN to the nearest rung.
 *
 * Fails closed by construction: a corrupt, absent or out-of-range stored value
 * lands on the LOWEST rung rather than the highest, so no degenerate row can
 * hand a cell a ceiling nobody promoted it to.
 */
export function normalizePhaseCeiling(value: number | undefined | null): number {
	if (value === undefined || value === null || !Number.isFinite(value)) {
		return RAMP_INITIAL_PHASE_CEILING;
	}
	let resolved = RAMP_INITIAL_PHASE_CEILING;
	for (const rung of RAMP_PHASE_CEILINGS) {
		if (value >= rung) resolved = rung;
	}
	return resolved;
}

/** The next rung up, or the current one when already at the top. */
export function nextPhaseCeiling(value: number): number {
	const current = normalizePhaseCeiling(value);
	for (const rung of RAMP_PHASE_CEILINGS) {
		if (rung > current) return rung;
	}
	return current;
}
