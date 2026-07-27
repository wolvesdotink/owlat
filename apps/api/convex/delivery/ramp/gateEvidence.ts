/**
 * Ramp controller — IS THIS EVIDENCE USABLE AT ALL? (plan D10, D15).
 *
 * Extracted from `gates.ts` when the engagement-ratio gate (P1-5) became the
 * second module that has to answer the question. `gates.ts` already said why
 * this belongs in exactly one place:
 *
 *   > Every observation this module reads — outcome buckets and seed sweeps
 *   > alike — goes through this one function, so the safety property cannot be
 *   > fixed in one place and left broken in the other.
 *
 * A second copy of the freshness rule in the engagement module would be a second
 * chance to get clock skew, staleness or a poisoned bucket subtly different, and
 * the two copies would disagree only in production. So the rule moved here and
 * both gate modules import it; nothing about the behaviour changed.
 *
 * PURE, like everything else under `ramp/`: `now` is a parameter, no database,
 * no environment, no randomness.
 */

import type { TransportOutcomeSummary } from '../../analytics/transportOutcomeSummary';
import type { RampGateThresholds } from './gateConfig';
import type {
	RampGateHoldMeasurement,
	RampGateHoldReason,
	RampGateId,
	RampGateResult,
} from './gateTypes';

/**
 * A rate that is not a usable fraction is not a rate. A poisoned bucket must
 * never be able to produce a `pass`, so an unusable value becomes `null` and
 * every caller reads `null` as "not measured". A value above 1 (counts that
 * exceed `sent`) is clamped rather than dropped: it is degenerate, but it is
 * degenerate in the unsafe direction and must still be able to fail a gate.
 */
export function safeRate(value: number | undefined | null): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
	return Math.min(1, value);
}

export type ArmEvidence = 'fresh' | 'thin' | 'stale' | 'absent';

/**
 * THE anti-clock-skew rule, written once.
 *
 * A large window recorded three weeks ago says nothing about the share we are
 * about to raise today, and future-dated evidence (clock skew between the MTA
 * and Convex) is not trusted at all.
 */
export function evidenceFreshness(
	recordedAt: number | null | undefined,
	now: number,
	thresholds: RampGateThresholds
): 'fresh' | 'stale' {
	if (typeof recordedAt !== 'number' || !Number.isFinite(recordedAt)) return 'stale';
	if (!Number.isFinite(now)) return 'stale';
	if (recordedAt > now + thresholds.maxFutureSkewMs) return 'stale';
	if (now - recordedAt > thresholds.maxEvidenceAgeMs) return 'stale';
	return 'fresh';
}

/** Is an arm's evidence usable at all? Presence, then sample size, then freshness. */
export function armEvidence(
	summary: TransportOutcomeSummary | null | undefined,
	sample: number,
	minSample: number,
	now: number,
	thresholds: RampGateThresholds
): ArmEvidence {
	if (!summary) return 'absent';
	if (!(sample >= minSample)) return 'thin';
	return evidenceFreshness(summary.lastRecordedAt, now, thresholds);
}

export function insufficient(
	gate: RampGateId,
	reason: RampGateHoldReason,
	measurement: RampGateHoldMeasurement
): RampGateResult {
	return { gate, status: 'insufficient_data', reason, measurement };
}

/**
 * The reason an unusable arm produces, mapped once so every gate agrees.
 *
 * Called only when the arm is unusable, so `fresh` here means the evidence was
 * fresh and large enough but the RATE itself was not a number — a poisoned
 * bucket, which is a different operator story from a thin window and must not
 * be reported as one.
 */
export function evidenceReason(
	evidence: ArmEvidence,
	arm: 'own' | 'reference'
): RampGateHoldReason {
	switch (evidence) {
		case 'absent':
			return 'evidence_absent';
		case 'stale':
			return arm === 'own' ? 'own_evidence_stale' : 'reference_evidence_stale';
		case 'thin':
			return arm === 'own' ? 'own_sample_below_floor' : 'reference_sample_below_floor';
		case 'fresh':
			return arm === 'own' ? 'own_rate_unmeasurable' : 'reference_rate_unmeasurable';
	}
}
