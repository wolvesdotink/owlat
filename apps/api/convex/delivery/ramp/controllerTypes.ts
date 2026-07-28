/**
 * The AIMD ramp controller's vocabulary (plan D9, D12, D15).
 *
 * Types only, so the pure decision function, the cron shell that feeds it and
 * the audit writer that records it share one contract without importing each
 * other.
 */

import type { DeliverabilityCell } from '@owlat/shared/deliverabilityRouting';
import type { RampStreamConfig } from './gateConfig';
import type { RampGateEvaluation, RampGateId, RampVerdict } from './gateTypes';

/**
 * Why the controller decided what it decided, as a stable machine-readable
 * code. A gate failure reports the GATE ID itself — the plan's `reason:
 * failedGate` — so an operator reading the audit row is told which measurement
 * broke rather than the useless fact that "a gate" broke.
 */
export type RampControlReason =
	/** The global kill switch is engaged: every cell is pinned. */
	| 'kill_switch'
	/** `now` was not a usable instant. Never decide against a broken clock. */
	| 'clock_unusable'
	/** Org abuse status forbids sending (ADR-0011). */
	| 'abuse_status'
	/** The MTA circuit breaker is open for this cell. */
	| 'breaker'
	/** At least one pool address carries a critical blocklist listing. */
	| 'dnsbl'
	/** A freeze from an earlier decision has not expired. */
	| 'frozen'
	/** The stored share was not a share (negative, above 1, or non-finite). */
	| 'share_unreadable'
	/** Thin or absent evidence (plan D10): hold, in both directions. */
	| 'holding'
	/**
	 * The gate aggregate is not a reading of the PRESENT: it was computed longer
	 * ago than `maxEvidenceAgeMs`, or stamped further ahead of the clock than
	 * `maxFutureSkewMs`. Held, in both directions — evidence has an expiry.
	 */
	| 'evidence_stale'
	/**
	 * A tripwire gate failed alone (plan D17). Seeds are 5-10 mailboxes: a
	 * collapse is actionable, but on its own it is SUSPECT, so the controller
	 * waits for the deferral or bounce gate to corroborate before halving.
	 */
	| 'awaiting_corroboration'
	/** The capacity projection was unusable, so no ceiling could be computed. */
	| 'capacity_unknown'
	/**
	 * Clean, but the current evaluation WINDOW has already been counted. The cron
	 * ticks hourly against a 24h window, so counting every tick would let three
	 * overlapping reads of the same day satisfy K_CLEAN.
	 */
	| 'window_open'
	/** Clean, but not clean for K_CLEAN consecutive windows yet. */
	| 'building_confidence'
	/** The warming-cap-derived ceiling is what bounds the share. */
	| 'capacity_ceiling'
	/** The phase-ladder rung is what bounds the share. */
	| 'phase_ceiling'
	/** An additive increase. The only reason that ever raises a share. */
	| 'healthy'
	/** s = 1.0 held 14 days with every gate green: the cell PINS. */
	| 'graduated';

export type RampDecisionReason = RampControlReason | RampGateId;

export type RampDecisionDirection = 'increase' | 'decrease' | 'hold';

/**
 * The controller's stored state for one cell, already read out of the route
 * state row. Every field is what was STORED, not what is valid: sanitising
 * degenerate values is the decision function's job, and doing it at the read
 * boundary instead would hide the hostile input the plan requires us to handle.
 */
export interface RampMixState {
	/**
	 * The STORED own share, verbatim and unsanitised — `-0.5`, `1.5` and `NaN`
	 * all reach the decision function as themselves. Only an ABSENT stored share
	 * is resolved by the caller (to `isFallbackActive ? 0 : 1`, plan D1), because
	 * absence is the one case that has a defined answer.
	 */
	readonly share: number;
	readonly phaseCeiling: number | undefined;
	readonly cleanStreak: number | undefined;
	/** Absolute instant the current freeze expires. */
	readonly frozenUntil: number | undefined;
	/** The instant the current freeze STARTED — the repeat-window test's input. */
	readonly freezeStartedAt: number | undefined;
	/** The cooldown length that produced the current freeze (the ladder position). */
	readonly cooldownMs: number | undefined;
	/** The instant the cell last became continuously green (graduation clock). */
	readonly greenSince: number | undefined;
	readonly graduatedAt: number | undefined;
	/**
	 * The instant the last COUNTED evaluation window was counted, or `undefined`
	 * for a cell that has never had one. Two counted windows must be at least
	 * `RAMP_AIMD.evaluationWindowMs` apart, so that K_CLEAN measures independent
	 * windows rather than overlapping hourly reads of the same day.
	 */
	readonly lastCountedAt: number | undefined;
}

/**
 * The SHIPPED hard-stop signals, read rather than re-derived: the org's abuse
 * status (ADR-0011), the MTA circuit breaker, and the DNSBL reading that
 * already drives shipped routing. The controller consumes verdicts here; it
 * does not own any of these policies.
 */
export interface RampHardStopSignals {
	/** `isSendingAllowed(instanceSettings.abuseStatus)`. */
	readonly isSendingAllowed: boolean;
	/** The MTA circuit breaker is open for this cell's provider slice. */
	readonly isCircuitBreakerOpen: boolean;
	/** A critical `dnsbl_listed` / `dnsbl_partial` signal on the pool. */
	readonly isPoolBlocklisted: boolean;
}

/**
 * The capacity projection, taken as a NARROW INPUT rather than computed here.
 *
 * P3-3 owns the real per-(IP x mailbox provider) projection. Keeping it behind
 * this type means that piece can replace the projection wholesale without
 * touching the decision function, and means the decision function stays
 * testable against a projection that is deliberately hostile.
 *
 * "NO PROJECTION AT ALL" IS ITS OWN SHAPE, not a pair of zeros. Until P3-3
 * lands there is no per-cell warming projection to read, and the share is
 * bounded by its PHASE CEILING alone — but a projected reading of zero headroom
 * against zero volume is also a perfectly legitimate thing P3-3 can produce for
 * a cell whose cap is spent and whose projected volume is zero, and the two must
 * not be the same value. `kind` is the difference, in the type rather than
 * in a constant whose meaning depends on a short-circuit three modules away.
 *
 * WHY NOT SHIP A STAND-IN PROJECTION MEANWHILE. The obvious approximation — the
 * deployment-wide remaining warming headroom over one cell's trailing volume —
 * is wrong in both directions. The numerator is shared by all fifteen cells, so
 * each one claims the whole deployment's headroom and the ceiling is far LOOSER
 * than the plan intends; and as the day's sends approach the cap that numerator
 * decays toward zero against a trailing-24h denominator that does not, so the
 * ceiling collapses and retreats cells whose gates are all green — a daily
 * sawtooth into the relay, with an admin notice attached to each one. A ceiling
 * nobody designed is worse than no ceiling at all. ABSENCE IS NOT A CONSTRAINT
 * (plan D2): a missing reading is never evidence of a full cap.
 */
export type RampCapacityInput =
	/** No per-cell warming projection is available; only the phase ceiling binds. */
	| { readonly kind: 'unconstrained' }
	| {
			readonly kind: 'projected';
			/** Sends of warming-cap headroom left for this cell in the window. */
			readonly warmingCapRemaining: number;
			/**
			 * Sends this cell is projected to make in the window. ZERO means "nothing
			 * to send", which is not a constraint — a cell with no projected volume
			 * is bounded by its phase ceiling alone.
			 */
			readonly projectedVolume: number;
	  };

export interface RampControllerInput {
	readonly cell: DeliverabilityCell;
	readonly config: RampStreamConfig;
	readonly mix: RampMixState;
	readonly signals: RampHardStopSignals;
	/**
	 * The gate aggregate for the window, or `null` when no evaluation could be
	 * produced at all. `null` HOLDS — it is thin evidence, not a failure.
	 */
	readonly evaluation: RampGateEvaluation | null;
	readonly capacity: RampCapacityInput;
	/** Plan P3-2's global kill switch. Honoured before every other rule. */
	readonly isKillSwitchEngaged: boolean;
	readonly now: number;
}

export interface RampDecision {
	/** The share to store, already clamped to [0, 1]. */
	readonly share: number;
	readonly fromShare: number;
	readonly reason: RampDecisionReason;
	readonly direction: RampDecisionDirection;
	/** `not_evaluated` when the decision was made before any gate was consulted. */
	readonly verdict: RampVerdict | 'not_evaluated';
	readonly failedGate: RampGateId | undefined;
	/** Absolute instant the cell is frozen until, or `undefined` for no new freeze. */
	readonly frozenUntil: number | undefined;
	/**
	 * The next COOLDOWN-LADDER position — set ONLY by a gate-breach freeze, and
	 * deliberately `undefined` for a hard-stop freeze even though the breaker's
	 * 6h and the blocklist's 24h are real freezes that really are imposed
	 * (`frozenUntil` is where those show up). Only a breach advances the ladder.
	 *
	 * Two readers depend on exactly that asymmetry, so it is load-bearing rather
	 * than incidental: `rampDecisionAdminNotice` and the audit-log emit in
	 * `rampControllerCron` both use it to tell a FRESH INCIDENT — a new breach,
	 * with a new rung and new durable state — from a CONDITION that is merely
	 * still true an hour later. A hold with a `cooldownMs` changed something; a
	 * hold without one did not.
	 */
	readonly cooldownMs: number | undefined;
	/** Clean-streak to store (already folded through the gate aggregate). */
	readonly cleanStreak: number;
	readonly phaseCeiling: number;
	/** The instant this cell became continuously green, or `undefined`. */
	readonly greenSince: number | undefined;
	readonly graduatedAt: number | undefined;
	/**
	 * Set to `now` when this evaluation COUNTED as a window (and is therefore the
	 * anchor the next window is measured from); `undefined` when it did not, in
	 * which case the caller must leave the stored anchor alone.
	 */
	readonly countedAt: number | undefined;
	/** The effective ceiling this decision was bounded by. */
	readonly ceiling: number;
}
