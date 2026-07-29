/**
 * THE PACE ACTUATOR'S VOCABULARY (plan D3, D12, D15).
 *
 * The second actuator behind the SAME controller. Everything it shares with the
 * share actuator is imported rather than restated — the hard-stop signals, the
 * gate aggregate, the freeze origins, the direction derivation — so the two
 * actuators can never come to mean different things by the same word.
 */

import type {
	RampDecisionDirection,
	RampDecisionReason,
	RampFreezeOrigin,
	RampHardStopSignals,
} from './controllerTypes';
import type { RampStreamConfig } from './gateConfig';
import type { RampGateEvaluation, RampGateId, RampVerdict } from './gateTypes';

/**
 * The pace actuator's own reasons, ON TOP OF the share actuator's. Every rung
 * the two share reports the same code, so an operator reading a pace decision
 * and a share decision is reading one vocabulary.
 */
export type PaceControlReason =
	/**
	 * THE ONE SANCTIONED BEHAVIOUR CHANGE (plan D19). The cap was not exercised
	 * enough for the window to say anything, so the actuator HOLDS. The shipped
	 * MTA evaluator treated the same reading as a failure to qualify for
	 * acceleration and advanced the schedule anyway; under pace control low
	 * utilisation is thin evidence, and thin evidence never moves the dial.
	 */
	| 'low_utilisation'
	/**
	 * The per-UTC-day idempotency guard (plan D19). An hourly controller must
	 * advance a warming schedule at most ONCE per UTC day; this window's day has
	 * already been counted, so the cell holds until tomorrow.
	 */
	| 'day_already_advanced'
	/**
	 * The composition interlock (plan D3). The SHARE moved first this window —
	 * cheap and instantly reversible, because the relay absorbs the difference —
	 * so the reputation-bearing pace dial waits. A cell may never increase both in
	 * one window, and "window" means the share's whole evaluation window, not the
	 * hour the two decisions happened to share.
	 */
	| 'share_moved_first'
	/** The stored multiplier was not one (outside [M_MIN, M_MAX], or non-finite). */
	| 'multiplier_unreadable'
	/**
	 * The dial is already at M_MAX. What limits the cap from here is the published
	 * base warming schedule, which the controller may never exceed for the current
	 * day (plan D19).
	 */
	| 'schedule_ceiling';

export type PaceDecisionReason = RampDecisionReason | PaceControlReason;

/**
 * The pace actuator's stored state for one cell, read off the route-state row.
 * Verbatim and unsanitised, exactly like `RampMixState`: making sense of a
 * degenerate reading is the decision function's job, and doing it at the read
 * boundary would hide the hostile input the plan requires us to survive.
 */
export interface PaceState {
	/** The stored growth multiplier, unsanitised. */
	readonly multiplier: number;
	readonly cleanStreak: number | undefined;
	readonly frozenUntil: number | undefined;
	readonly freezeReason: RampFreezeOrigin | undefined;
	readonly freezeStartedAt: number | undefined;
	readonly cooldownMs: number | undefined;
	/**
	 * The `YYYY-MM-DD` UTC day this cell's pace was last EVALUATED on — the
	 * per-UTC-day idempotency guard, and deliberately the same shape and the same
	 * meaning as the MTA evaluator's `lastEvaluatedDate`. Absent for a cell that
	 * has never been evaluated.
	 */
	readonly lastEvaluatedUtcDay: string | undefined;
	/**
	 * THE COMPOSITION INTERLOCK'S ANCHOR (plan D3): the instant a pace increase
	 * was last WITHHELD because the share moved first. Absent for a cell that has
	 * never been deferred — the standalone case, where there is no share decision
	 * at all and the interlock has nothing to interlock.
	 *
	 * It is an INSTANT and not a UTC day key because the property it enforces is
	 * stated in windows: the share's evaluation window is
	 * `RAMP_AIMD.evaluationWindowMs`, which starts when the share moved and has
	 * nothing to do with where midnight falls.
	 */
	readonly deferredAt: number | undefined;
}

/**
 * HOW MUCH OF THE CAP THE CELL ACTUALLY USED — the pace actuator's evidence
 * that the cap it holds is a cap anyone is exercising.
 *
 * `unknown` is its own shape rather than a pair of zeros, for the reason
 * `RampCapacityInput` keeps them apart: "no warming reading arrived" and "the
 * cap was known and nothing was sent against it" are different facts, and only
 * the second is evidence.
 */
export type PaceUtilisationReading =
	| { readonly kind: 'unknown' }
	| {
			readonly kind: 'measured';
			/** Sends made against the cap in the window. */
			readonly sent: number;
			/** The cap that was actually enforced over the window. */
			readonly enforcedCap: number;
	  };

export interface PaceControllerInput {
	readonly config: RampStreamConfig;
	readonly pace: PaceState;
	readonly signals: RampHardStopSignals;
	/** The gate aggregate, or `null` when none could be produced. `null` HOLDS. */
	readonly evaluation: RampGateEvaluation | null;
	readonly utilisation: PaceUtilisationReading;
	readonly isKillSwitchEngaged: boolean;
	readonly now: number;
}

/** A freeze the pace actuator imposes. Same shape and rules as the share's. */
export interface PaceDecisionFreeze {
	readonly until: number;
	readonly origin: RampFreezeOrigin;
	/** Present only on a gate-breach freeze — only a breach advances the ladder. */
	readonly ladderMs?: number | undefined;
}

export interface PaceDecision {
	/** The multiplier to store, already clamped to [M_MIN, M_MAX]. */
	readonly multiplier: number;
	readonly fromMultiplier: number;
	readonly reason: PaceDecisionReason;
	readonly direction: RampDecisionDirection;
	readonly verdict: RampVerdict | 'not_evaluated';
	readonly failedGate: RampGateId | undefined;
	readonly freeze: PaceDecisionFreeze | undefined;
	readonly cleanStreak: number;
	/**
	 * The UTC day key to store as the new idempotency anchor, or `undefined` when
	 * this evaluation did NOT count the day and the caller must leave the stored
	 * anchor exactly as it found it.
	 *
	 * Only a decision made on real, sufficient evidence counts a day: an
	 * unmeasured or under-exercised window deliberately leaves the guard unset, so
	 * a later tick the same day — once volume has arrived — can still evaluate it
	 * once. That is the shipped evaluator's own `sent === 0` rule, kept.
	 */
	readonly countedUtcDay: string | undefined;
}

/** What a rung returns, before the shell turns it into a decision. */
export interface PaceDecisionDraft {
	readonly multiplier: number;
	readonly reason: PaceDecisionReason;
	readonly verdict: PaceDecision['verdict'];
	readonly failedGate?: RampGateId | undefined;
	readonly freezeMs?: number | undefined;
	readonly freezeReason?: RampFreezeOrigin | undefined;
	readonly isLadderFreeze?: boolean;
	readonly cleanStreak: number;
	readonly countedUtcDay?: string | undefined;
}
