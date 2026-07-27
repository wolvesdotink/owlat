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
	RampGateGrade,
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

/**
 * The SAME question for a gate whose polarity is inverted — and it needs a
 * different answer, which is why it is a second function rather than a flag.
 *
 * `safeRate` clamps a value above 1 instead of dropping it because for gates 1,
 * 2 and 3 HIGH IS BAD: a hard-bounce rate of 1.5 clamped to 1.0 still fails
 * every ceiling, so the clamp is degenerate in the safe direction.
 *
 * The engagement gate inverts that: HIGH IS GOOD. A poisoned own-arm rate of 1.5
 * clamped to 1.0 divides by any reference rate to something at or above the
 * ratio floor, so the clamp would manufacture the ONE verdict the AIMD
 * controller is allowed to raise a share on. Nothing on the real read path can
 * produce a value above 1 (`summarizeTransportOutcomeBuckets` clamps at the read
 * boundary), so a value above 1 arriving here is corruption and must be treated
 * as "not measured" rather than as data.
 */
export function safeEngagementRate(value: number | undefined | null): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
	return value;
}

export type ArmEvidence = 'fresh' | 'thin' | 'stale' | 'absent';

/**
 * THE anti-clock-skew rule, written once.
 *
 * A large window recorded three weeks ago says nothing about the share we are
 * about to raise today, and future-dated evidence (clock skew between the MTA
 * and Convex) is not trusted at all.
 *
 * THE MAX AGE IS A PARAMETER, NOT A CONSTANT READ OFF `thresholds`. Almost every
 * series a gate reads is CONCURRENT, and for those the age allowance is
 * `thresholds.maxEvidenceAgeMs`. The slow-poison floor's second series is not:
 * its window ends a week ago by contract, so judging it by the concurrent rule
 * marks it stale on every real input and silently deletes the gate. The caller
 * therefore states which allowance applies, so a series with an unusual window
 * cannot inherit a rule that does not describe it. The skew tolerance stays on
 * `thresholds` — a future-dated observation is untrustworthy for every series.
 */
export function evidenceFreshness(
	recordedAt: number | null | undefined,
	now: number,
	thresholds: RampGateThresholds,
	maxAgeMs: number
): 'fresh' | 'stale' {
	if (typeof recordedAt !== 'number' || !Number.isFinite(recordedAt)) return 'stale';
	if (!Number.isFinite(now)) return 'stale';
	if (recordedAt > now + thresholds.maxFutureSkewMs) return 'stale';
	if (now - recordedAt > maxAgeMs) return 'stale';
	return 'fresh';
}

/** Is an arm's evidence usable at all? Presence, then sample size, then freshness. */
export function armEvidence(
	summary: TransportOutcomeSummary | null | undefined,
	sample: number,
	minSample: number,
	now: number,
	thresholds: RampGateThresholds,
	maxAgeMs: number
): ArmEvidence {
	if (!summary) return 'absent';
	if (!(sample >= minSample)) return 'thin';
	return evidenceFreshness(summary.lastRecordedAt, now, thresholds, maxAgeMs);
}

/**
 * A HOLD carries the gate's grade like every other verdict (plan D14): a hold is
 * a verdict, the UI renders it, and "we could not measure this" from a
 * high-confidence gate and from a proxy are different sentences to an operator.
 */
export function insufficient(
	gate: RampGateId,
	reason: RampGateHoldReason,
	measurement: RampGateHoldMeasurement,
	grade: RampGateGrade
): RampGateResult {
	return { gate, status: 'insufficient_data', reason, measurement, ...grade };
}

/**
 * The reason an unusable arm produces, mapped once so every gate agrees.
 *
 * Called only when the arm is unusable, so `fresh` here means the evidence was
 * fresh and large enough but the RATE itself was not a number — a poisoned
 * bucket, which is a different operator story from a thin window and must not
 * be reported as one.
 *
 * THREE arms, not two. A hold reason exists to NAME THE THING TO FIX, and
 * "reference" names a second transport an operator can go and look at. The
 * slow-poison floor's second series is the cell's OWN past, so reporting
 * `reference_evidence_stale` there would send that operator hunting for a relay
 * problem that does not exist.
 */
export function evidenceReason(
	evidence: ArmEvidence,
	arm: 'own' | 'reference' | 'baseline'
): RampGateHoldReason {
	switch (evidence) {
		case 'absent':
			return 'evidence_absent';
		case 'stale':
			return arm === 'own'
				? 'own_evidence_stale'
				: arm === 'reference'
					? 'reference_evidence_stale'
					: 'baseline_evidence_stale';
		case 'thin':
			return arm === 'own'
				? 'own_sample_below_floor'
				: arm === 'reference'
					? 'reference_sample_below_floor'
					: 'baseline_sample_below_floor';
		case 'fresh':
			return arm === 'own'
				? 'own_rate_unmeasurable'
				: arm === 'reference'
					? 'reference_rate_unmeasurable'
					: 'baseline_rate_unmeasurable';
	}
}
