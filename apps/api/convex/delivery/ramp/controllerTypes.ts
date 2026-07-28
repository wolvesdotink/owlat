/**
 * The AIMD ramp controller's vocabulary (plan D9, D12, D15).
 *
 * Shared vocabulary: the types the pure decision function, the cron shell that
 * feeds it and the audit writer that records it all agree on, plus the two tiny
 * total derivations over them that more than one of those callers needs.
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
	/**
	 * The stored freeze expiry was not one: further in the future than any rung of
	 * this controller can stamp. Held — a freeze we cannot read is not permission
	 * to step up — but named apart from `frozen`, whose sentence promises the
	 * operator an instant the hold really ends at.
	 */
	| 'freeze_unreadable'
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

/**
 * WHICH RUNG STAMPED A FREEZE.
 *
 * Three rungs can freeze a cell and they do NOT mean the same thing, so the row
 * records which one it was. The breaker rung declines to re-charge its retreat
 * while ITS OWN freeze runs — charging one incident once — and without an origin
 * on the row that suppression would extend to any freeze at all, letting a
 * multi-hour gate cooldown swallow the halving a newly-open circuit breaker is
 * supposed to cost. A hard stop must never be absorbed by an unrelated cooldown.
 */
export type RampFreezeOrigin =
	/** A gate breach: the AIMD cooldown ladder (6h, doubling, capped at 48h). */
	| 'gate_breach'
	/** The MTA circuit breaker opened for this cell. */
	| 'breaker'
	/** A pool address carries a critical blocklist listing. */
	| 'dnsbl';

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
	/**
	 * Which rung stamped the freeze `frozenUntil` belongs to, or `undefined` on a
	 * row frozen before the origin was recorded. Unknown is never read as "the
	 * breaker's" — see `RampFreezeOrigin`.
	 */
	readonly freezeReason: RampFreezeOrigin | undefined;
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
 * WHAT P3-3 ACTUALLY SUPPLIES, and how it answers the two hazards this comment
 * used to reject a stand-in for. The shipped warming sync reports headroom for
 * the CAMPAIGN POOL as a whole, not per (IP x mailbox provider), so a ceiling
 * that divided the pool's headroom by ONE cell's volume would hand the same
 * numerator to all fifteen cells and the sum of what they were allowed would
 * exceed the cap fifteenfold. The bound that actually holds comes straight out
 * of the constraint it has to satisfy — with a share `s_c` and a projected
 * demand `V_c` per cell, own-arm volume is `sum(s_c * V_c)`, so
 * `s_c <= headroom / sum(V_c)` for every cell is what keeps the total inside the
 * cap. The denominator is therefore the DEPLOYMENT'S projected demand, summed
 * over per-cell projections, and the resulting ceiling is legitimately the same
 * number for every cell. The second hazard — a remaining cap decaying toward
 * zero against a denominator that does not, sawtoothing healthy cells into the
 * relay every afternoon — is answered by comparing like with like: both sides
 * are what is LEFT OF TODAY (`remainingDemandToday`), and the last sliver of the
 * day holds rather than decides.
 *
 * ABSENCE IS NOT A CONSTRAINT (plan D2): a missing warming reading is never
 * evidence of a full cap, so it stays `unconstrained`. An unusable DEMAND
 * reading is a different thing — it is a ceiling we cannot compute at all — and
 * it holds.
 */
export type RampCapacityInput =
	/** No warming reading at all; only the phase ceiling binds (plan D2). */
	| { readonly kind: 'unconstrained' }
	/**
	 * A warming cap is known but the demand it must be divided by is not (a
	 * brand-new deployment, a paused week, the last sliver of a UTC day). HOLD:
	 * neither an unbounded ceiling nor a zero one.
	 */
	| { readonly kind: 'unknown'; readonly reason: string }
	| {
			readonly kind: 'projected';
			/** Sends of warming-cap headroom left for the rest of today. */
			readonly warmingCapRemaining: number;
			/**
			 * Sends the DEPLOYMENT is projected to make in the rest of today — the
			 * denominator that keeps the sum of every cell's own-arm volume inside the
			 * cap (see above). ZERO means "nothing to send", which is not a constraint;
			 * P3-3's projection never produces it, because a zero projection is an
			 * `unknown` decided in `projectCellVolume` rather than a division here.
			 */
			readonly projectedVolume: number;
			/**
			 * THIS CELL'S own trailing evidence, carried for the audit snapshot (plan
			 * D12) and read by NO rung. The numbers above are deployment-level by
			 * derivation, so without this the row could not say which cell's demand
			 * contributed what, nor that the own arm failed to carry the share it was
			 * assigned (`rerouteMissRate`).
			 */
			readonly cellEvidence?: {
				readonly projectedCellVolume: number;
				readonly observedDays: number;
				readonly ownFraction: number;
				readonly missRate: number | null;
			};
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

/**
 * A FREEZE, WHOLE. The instant it ends, the rung that imposed it, and — only for
 * a gate breach — the cooldown-ladder position the next breach doubles from.
 */
export interface RampDecisionFreeze {
	/** Absolute instant the cell is frozen until. */
	readonly until: number;
	/**
	 * Which rung stamped it. A freeze whose origin nobody recorded is exactly the
	 * state the breaker rung must not mistake for its own, which is why it cannot
	 * be omitted here.
	 */
	readonly origin: RampFreezeOrigin;
	/**
	 * The next COOLDOWN-LADDER position — present ONLY on a gate-breach freeze,
	 * and deliberately absent on a hard-stop freeze even though the breaker's 6h
	 * and the blocklist's 24h are real freezes that really are imposed (`until`
	 * is where those show up). Only a breach advances the ladder.
	 *
	 * Two readers depend on exactly that asymmetry, so it is load-bearing rather
	 * than incidental: `rampDecisionAdminNotice` and the audit-log emit in
	 * `rampControllerCron` — both through `rampDecisionChangedState` — use it to
	 * tell a FRESH INCIDENT (a new breach, with a new rung and new durable state)
	 * from a CONDITION that is merely still true an hour later. A hold with a
	 * ladder position changed something; a hold without one did not.
	 */
	readonly ladderMs?: number | undefined;
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
	/**
	 * The freeze this decision imposes, or `undefined` for no new freeze. ONE
	 * member rather than three loose columns: the expiry, the rung it belongs to
	 * and the ladder position always travelled together, and "an origin never
	 * travels without an instant" was previously a prose rule kept true by a
	 * runtime ternary. As a nested member it is a property of the TYPE.
	 */
	readonly freeze: RampDecisionFreeze | undefined;
	/** Clean-streak to store (already folded through the gate aggregate). */
	readonly cleanStreak: number;
	readonly phaseCeiling: number;
	/** The instant this cell became continuously green, or `undefined`. */
	readonly greenSince: number | undefined;
	readonly graduatedAt: number | undefined;
	/**
	 * WHETHER THIS DECISION MOVED THE GRADUATION PIN, and which way — `undefined`
	 * when the pin is exactly what the row already held.
	 *
	 * Derived once, in the shell, rather than left to each caller to reconstruct by
	 * comparing `decision.graduatedAt` against a row it would have to still be
	 * holding: a pin transition is the piece's TERMINAL state change (the cell pins
	 * and the relay drops to `priority_failover` standby) and it happens while the
	 * SHARE DOES NOT MOVE, so `direction` cannot see it.
	 */
	readonly pinChange: RampPinChange | undefined;
	/**
	 * Set to `now` when this evaluation COUNTED as a window (and is therefore the
	 * anchor the next window is measured from); `undefined` when it did not, in
	 * which case the caller must leave the stored anchor alone.
	 */
	readonly countedAt: number | undefined;
	/** The effective ceiling this decision was bounded by. */
	readonly ceiling: number;
}

/**
 * A graduation pin AWARDED to a cell that did not have one, or REVOKED from a
 * cell that did.
 */
export type RampPinChange = 'awarded' | 'revoked';

/**
 * The pin transition between what the row stored and what this decision writes.
 * `stored` is the SANITISED reading (`readStoredInstant`), not the raw column: a
 * degenerate instant is not a pin, so clearing one is not a revocation anybody
 * needs to be told about.
 */
export function rampPinChange(
	stored: number | null,
	next: number | undefined
): RampPinChange | undefined {
	if (stored === null && next !== undefined) return 'awarded';
	if (stored !== null && next === undefined) return 'revoked';
	return undefined;
}

/**
 * WHAT A RUNG RETURNS, before the shell turns it into a decision.
 *
 * `controller.ts` exists to hold the PRECEDENCE LADDER and nothing else, so the
 * draft shape and the direction derivation live here with the rest of the
 * vocabulary rather than crowding the one function a reviewer must read end to
 * end.
 */
export interface RampDecisionDraft {
	readonly share: number;
	readonly reason: RampDecisionReason;
	readonly verdict: RampDecision['verdict'];
	readonly failedGate?: RampGateId | undefined;
	/** How long THIS rung's freeze runs. The shell turns it into an instant. */
	readonly freezeMs?: number | undefined;
	/** Which rung stamped `freezeMs`. Set by every rung that sets a freeze. */
	readonly freezeReason?: RampFreezeOrigin | undefined;
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

export function rampDecisionDirection(fromShare: number, share: number): RampDecisionDirection {
	if (share > fromShare) return 'increase';
	if (share < fromShare) return 'decrease';
	return 'hold';
}

/**
 * DID THIS DECISION CHANGE DURABLE STATE? One rule, one spelling.
 *
 * A gate breach on a cell already sitting on the share floor returns direction
 * `hold` — `max(floor, floor x 0.5)` is the floor — yet it rewrites the freeze
 * expiry, the cooldown rung, the clean streak and the green clock. That is a
 * real automatic change: it belongs in the audit log and it earns an admin
 * notice. The ladder position is the exact discriminator, because only a breach
 * sets one.
 *
 * The audit emit and the admin notice MUST agree about this, so they share the
 * predicate rather than each spelling out the same condition.
 *
 * THE PIN TRANSITION IS THE THIRD ARM, and it is the piece's TERMINAL state
 * change: graduation returns `direction: 'hold'` (the pinned target IS the
 * current share) and imposes no freeze, yet it writes `graduatedAt` onto a row
 * that had none — the cell pins and the relay drops to `priority_failover`
 * standby. Without this arm that transition, and the hard-stop revocation that
 * undoes it, would never reach `auditLogs` at all. It cannot make a graduation
 * cry wolf on the notice path: `rampDecisionAdminNotice` also requires a NAMED
 * cause, and `graduated` is not one.
 */
export function rampDecisionChangedState(decision: RampDecision): boolean {
	if (decision.direction !== 'hold') return true;
	if (decision.freeze?.ladderMs !== undefined) return true;
	return decision.pinChange !== undefined;
}
