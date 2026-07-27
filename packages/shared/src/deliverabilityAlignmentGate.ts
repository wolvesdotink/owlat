/**
 * The dual-transport alignment GATE (P3-5) — the half of the pre-flight the ramp
 * controller actually calls.
 *
 * `deliverabilityAlignment.ts` decides whether two arms ARE aligned, from live
 * DNS facts. This module decides whether a STORED verdict may still be trusted to
 * open the gate, and turns that answer into a share. Split out because the
 * evaluator sits at the repo's 500-LOC cap and because these are two different
 * jobs: one reads DNS, the other reads a clock.
 *
 * Pure: the clock and the stored state are parameters (D15).
 */

import type { AlignmentVerdict } from './deliverabilityAlignment';

/** Beyond this, a recorded verdict is no longer evidence of anything. */
export const ALIGNMENT_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

/**
 * Clock skew tolerated in the FORWARD direction, mirroring
 * `DELIVERABILITY_SNAPSHOT_MAX_FUTURE_SKEW_MS`. A `checkedAt` beyond this is not
 * a fresh verdict written a moment ago — it is a row written under a skewed
 * clock, and treating it as authoritative would pin an `aligned` verdict for as
 * long as the skew lasts.
 */
export const ALIGNMENT_MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;

export type AlignmentGateReason =
	| 'single_arm'
	| 'aligned'
	| 'blocked'
	| 'unknown_hold'
	| 'reference_arm_unknown'
	| 'not_yet_checked'
	| 'stale';

export interface AlignmentGateState {
	verdict: AlignmentVerdict;
	checkedAt: number;
}

/** How the second arm stands, answered from the shipped transport surface. */
export type ReferenceArmPresence = 'none' | 'configured' | 'unknown';

export interface AlignmentGateInput {
	/** `none` ⇒ no reference transport; the gate opens regardless of state (D2). */
	referenceArm: ReferenceArmPresence;
	state: AlignmentGateState | null;
	now: number;
}

export interface AlignmentGateVerdict {
	allowsShareAboveZero: boolean;
	reason: AlignmentGateReason;
}

/**
 * The controller's gate. Everything that is not a fresh, positive verdict HOLDS
 * the cell at s=0 — EXCEPT the single-arm case, which never depends on a stored
 * result at all, so a deployment with zero third-party accounts can never be
 * blocked by a pre-flight that has not run.
 *
 * Freshness is bounded in BOTH directions. A `checkedAt` in the future beyond the
 * tolerated skew is as unusable as one two days old: it would otherwise keep an
 * `aligned` verdict authoritative for as long as the clock is wrong.
 */
export function alignmentGate(input: AlignmentGateInput): AlignmentGateVerdict {
	if (input.referenceArm === 'none') {
		return { allowsShareAboveZero: true, reason: 'single_arm' };
	}
	if (input.referenceArm === 'unknown') {
		return { allowsShareAboveZero: false, reason: 'reference_arm_unknown' };
	}
	const state = input.state;
	if (state === null) return { allowsShareAboveZero: false, reason: 'not_yet_checked' };
	// A STORED `single_arm` verdict is, by definition, a verdict recorded while no
	// relay existed. Now that one does, it is not evidence of anything about the
	// two arms — and it is the one verdict a domain can hold forever without being
	// refreshed, so honouring it here would open the gate on a pre-relay row with
	// no staleness bound at all. `referenceArm === 'none'` (handled above) is the
	// ONLY single-arm ground for opening.
	if (state.verdict === 'single_arm') {
		return { allowsShareAboveZero: false, reason: 'not_yet_checked' };
	}
	const age = input.now - state.checkedAt;
	if (
		!Number.isFinite(age) ||
		age > ALIGNMENT_STALE_AFTER_MS ||
		age < -ALIGNMENT_MAX_FUTURE_SKEW_MS
	) {
		return { allowsShareAboveZero: false, reason: 'stale' };
	}
	if (state.verdict === 'aligned') return { allowsShareAboveZero: true, reason: 'aligned' };
	return {
		allowsShareAboveZero: false,
		reason: state.verdict === 'unknown' ? 'unknown_hold' : 'blocked',
	};
}

/**
 * Apply the gate to a proposed share: a blocked cell can only be held at 0.
 *
 * This is a BOUNDARY, so it also sanitises the share it is handed — a NaN,
 * an Infinity or an out-of-range number must not be able to travel through an
 * open gate into the route state.
 */
export function applyAlignmentGateToShare(share: number, gate: AlignmentGateVerdict): number {
	if (!gate.allowsShareAboveZero) return 0;
	if (!Number.isFinite(share)) return 0;
	return Math.min(1, Math.max(0, share));
}
