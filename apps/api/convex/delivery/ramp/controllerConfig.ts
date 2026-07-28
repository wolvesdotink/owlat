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
import type { RampMixState } from './controllerTypes';

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
	 * A breach within this long of the PREVIOUS freeze's start is a REPEAT and
	 * doubles the cooldown; a breach after it starts again from the base. The
	 * shape mirrors the shipped MTA circuit breaker so an operator only has one
	 * back-off model to hold in their head.
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
 * The cooldown ladder (plan D9): 6h, DOUBLING when the breach repeats within
 * 24h of the previous freeze's start, capped at 48h.
 *
 * A missing, corrupt or non-positive stored ladder position restarts at the
 * base rather than propagating garbage — the ladder is a penalty, and a penalty
 * derived from an unreadable number is not a penalty anyone can defend.
 */
export function nextCooldownMs(mix: RampMixState, now: number): number {
	const { cooldownBaseMs, cooldownMaxMs, cooldownRepeatWindowMs } = RAMP_AIMD;
	const startedAt = readStoredInstant(mix.freezeStartedAt, now);
	const isRepeat = startedAt !== null && now - startedAt < cooldownRepeatWindowMs;
	const previous = mix.cooldownMs;
	if (!isRepeat || previous === undefined || !Number.isFinite(previous) || previous <= 0) {
		return cooldownBaseMs;
	}
	return Math.min(cooldownMaxMs, previous * 2);
}

/**
 * The phase ceiling ladder. A cell may not exceed its current rung however
 * clean its gates are; promotion between rungs is a separate, deliberate act
 * (manual or criteria-gated) rather than something the hourly AIMD loop does on
 * its own — that is the point of having a ladder at all.
 */
const RAMP_PHASE_CEILINGS = [0.25, 0.5, 0.8, 1] as const;

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
