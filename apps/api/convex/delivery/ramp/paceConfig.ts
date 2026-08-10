/**
 * THE PACE ACTUATOR'S BOUNDS (ADR-0054 §1 and §4, plan D3, D9, D19).
 *
 * These are a safety surface, not a config surface, for the same reason
 * `RAMP_AIMD` is: see `docs/adr/0054-deliverability-ramp-controller.md`.
 *
 * The controller is not really about transport share — it is about how fast we
 * let volume grow against measured evidence. Standalone there is no mix to
 * control (s === 1 by definition), so the controlled variable becomes a GROWTH
 * MULTIPLIER on the per-(IP x mailboxProvider) daily cap. Same gates, same
 * AIMD, same guardrails; different bounds.
 *
 * THE FREEZE LADDER IS THE SHARE ACTUATOR'S, reused rather than re-declared:
 * `RAMP_AIMD` owns the cooldown base, the doubling window, the cap and the two
 * hard-stop freezes, and a second table of the same numbers is a table that can
 * disagree. Only the numbers that are genuinely about a MULTIPLIER live here.
 *
 * WHAT BOUNDS THE MULTIPLIER, and what does NOT. M_MAX is a bound on the DIAL,
 * not on the cap: the published base warming schedule is a HARD ceiling the
 * controller may never exceed for the current day (plan D19), and that ceiling
 * is applied in `effectiveDailyCap` where the cap is actually computed. The dial
 * can therefore ask for more per-provider headroom than the shipped fixed split
 * allows — up to the IP's own published cap and not one send further — while a
 * multiplier below 1 is the controller choosing to go SLOWER than the published
 * ramp, which it is always free to do.
 */

import { RAMP_AIMD } from './controllerConfig';

export interface PaceAimdConfig {
	/**
	 * M_MIN — the multiplier a SOFT failure may never fall below. Never zero, for
	 * the reason the share floor is never zero: a cap of nothing sends nothing,
	 * and a cell that sends nothing can never be re-measured, so it could never
	 * recover.
	 */
	readonly multiplierFloor: number;
	/**
	 * M_MAX — the furthest the dial may travel. The published schedule still
	 * bounds the resulting cap, so this is headroom to ask with, never permission
	 * to exceed the day's ceiling.
	 */
	readonly multiplierCeiling: number;
	/** STEP — additive increase per clean UTC day. */
	readonly increaseStep: number;
	/** Multiplicative decrease the instant any gate breaches (the share's). */
	readonly decreaseFactor: number;
}

export const PACE_AIMD: PaceAimdConfig = {
	multiplierFloor: 0.25,
	multiplierCeiling: 1.5,
	increaseStep: 0.1,
	decreaseFactor: RAMP_AIMD.decreaseFactor,
};

/** The multiplier a cell starts at: the published schedule, unmodified. */
export const PACE_INITIAL_MULTIPLIER = 1;
