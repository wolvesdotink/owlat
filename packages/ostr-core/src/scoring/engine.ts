/**
 * Assembly of `ostr-policy-v1`: signals → per-observer caps → score → tier →
 * explanation (plan §6.1-§6.3).
 *
 * `computeScore` is parameterized by a {@link ScoringContext} so the same code
 * path serves both the caller-facing score (witnesses weighted by their own
 * standing) and the depth-1 standing computation (all witnesses at base
 * weight). See `standing.ts` for the recursion bound.
 *
 * The §6.3 bounds — the per-observer cap and the `flagged` diversity rule —
 * are applied per *control group*, not per observer name. A party that mints
 * `mx2.x`, `mx3.x`, `mx4.x` gets one party's cap, which is what §7.3 means by
 * "diversity-collapsed to ~one observer's cap".
 */

import type { LogEntryRef, ScoreResult, SubjectRef, Tier, VouchBody } from '../types.js';
import { diversitySignal, postureSignal, vouchSignal, type VouchLoad } from './boundedSignals.js';
import { extractFacts } from './facts.js';
import { clamp, isAtOrBefore, roundTo } from './math.js';
import { POLICY_V1 } from './policy.js';
import {
	bodyOf,
	entryKey,
	normalizeSubject,
	observerKey,
	selectSubjectEntries,
	type MergedEntry,
	type ObserverGrouper,
} from './select.js';
import {
	authConsistencySignal,
	authQuality,
	bounceRateSignal,
	complaintRateSignal,
	contributionOf,
	historyVolumeSignal,
	observedHistoryDays,
	trapHitSignal,
	type ObserverWeigher,
	type SignalGroup,
} from './signals.js';

/** Everything a scoring pass needs beyond the entries and the subject. */
export interface ScoringContext {
	asOf: string;
	weightFor: ObserverWeigher;
	/** Maps an observer to the party that controls it, for the §6.3 bounds. */
	groupOf: ObserverGrouper;
	/** Outstanding vouches per voucher across the whole entry set (plan §6.4). */
	vouchLoad: VouchLoad;
}

/**
 * Count each voucher's live vouches over every subject in the entry set, so
 * `vouchSignal` can dilute a voucher that is underwriting many subjects at
 * once. Expired and revoked vouches are not outstanding and do not dilute.
 */
export function createVouchLoad(
	ordered: readonly MergedEntry[],
	excluded: ReadonlySet<string>,
	asOf: string
): VouchLoad {
	const counts = new Map<string, number>();
	for (const entry of ordered) {
		if (entry.attestation.kind !== 'vouch') continue;
		if (excluded.has(entryKey(entry))) continue;
		const body = bodyOf<VouchBody>(entry.attestation);
		if (typeof body.expires !== 'string' || isAtOrBefore(body.expires, asOf)) continue;
		const voucher = observerKey(entry.attestation.observer);
		counts.set(voucher, (counts.get(voucher) ?? 0) + 1);
	}
	return (voucher: string): number => counts.get(voucher) ?? 0;
}

/**
 * Scale every party's parts so that no control group's summed contribution
 * exceeds `POLICY_V1.perObserverCapPoints` in either direction (plan §6.3).
 * Positive and negative parts of the same party offset first: the cap is on net
 * movement, which is what "no single witness moves a subject more than X
 * points" means.
 */
function applyPerObserverCap(groups: readonly SignalGroup[], groupOf: ObserverGrouper): void {
	const totals = new Map<string, number>();
	for (const group of groups) {
		for (const [observer, part] of group.parts) {
			const key = groupOf(observer);
			totals.set(key, (totals.get(key) ?? 0) + part);
		}
	}
	const scales = new Map<string, number>();
	for (const [key, total] of totals) {
		const magnitude = total < 0 ? -total : total;
		if (magnitude > POLICY_V1.perObserverCapPoints) {
			scales.set(key, POLICY_V1.perObserverCapPoints / magnitude);
		}
	}
	if (scales.size === 0) return;
	for (const group of groups) {
		for (const [observer, part] of group.parts) {
			const scale = scales.get(groupOf(observer));
			if (scale !== undefined) group.parts.set(observer, part * scale);
		}
	}
}

/** Parties whose net negative evidence is material (plan §6.3 diversity rule). */
function distinctNegativeObservers(
	groups: readonly SignalGroup[],
	groupOf: ObserverGrouper
): number {
	const negatives = new Map<string, number>();
	for (const group of groups) {
		for (const [observer, part] of group.parts) {
			if (!(part < 0)) continue;
			const key = groupOf(observer);
			negatives.set(key, (negatives.get(key) ?? 0) + part);
		}
	}
	let count = 0;
	for (const total of negatives.values()) {
		if (total <= -POLICY_V1.evidenceEpsilonPoints) count++;
	}
	return count;
}

function bandOf(score: number): Tier {
	const tiers = POLICY_V1.tiers;
	if (score < tiers.flaggedBelow) return 'flagged';
	if (score < tiers.warnedBelow) return 'warned';
	if (score < tiers.unknownBelow) return 'unknown';
	if (score < tiers.establishingBelow) return 'establishing';
	return 'trusted';
}

/**
 * Tier from the score, with the three policy overrides:
 *  - `flagged` additionally requires negative evidence from at least
 *    `flaggedMinDistinctObservers` parties under disjoint control; below that it
 *    is capped at `warned`, whatever the score.
 *  - without observed positive evidence, self-asserted posture and vouches
 *    cannot carry a subject past `establishing`.
 *  - `trusted` means "sustained clean history across diverse observers", so it
 *    also requires `POLICY_V1.history.sustainedDays` of log-anchored observed
 *    history. Everything else in the top band — perfect reported
 *    authentication, self-published posture, corroboration between observers —
 *    is available to a ring of domains registered this morning; elapsed time on
 *    the log is not, which is the whole reason the plan calls it the hardest
 *    signal to fake.
 */
function tierOf(
	score: number,
	groups: readonly SignalGroup[],
	groupOf: ObserverGrouper,
	historyDays: number
): Tier {
	let tier = bandOf(score);
	if (
		tier === 'flagged' &&
		distinctNegativeObservers(groups, groupOf) < POLICY_V1.flaggedMinDistinctObservers
	) {
		tier = 'warned';
	}
	if (tier !== 'trusted') return tier;
	const hasObservedPositive = groups.some(
		(group) => group.observed && contributionOf(group) > POLICY_V1.evidenceEpsilonPoints
	);
	if (!hasObservedPositive) return POLICY_V1.posture.maxTierWithoutObservedEvidence;
	if (historyDays < POLICY_V1.history.sustainedDays) {
		return POLICY_V1.history.maxTierWithoutSustainedHistory;
	}
	return tier;
}

function compareRefs(a: LogEntryRef, b: LogEntryRef): number {
	if (a.logId !== b.logId) return a.logId < b.logId ? -1 : 1;
	return a.index - b.index;
}

/** Groups sorted by |contribution| descending, ties broken by signal name. */
function compareGroups(
	a: { signal: string; contribution: number },
	b: { signal: string; contribution: number }
): number {
	const left = a.contribution < 0 ? -a.contribution : a.contribution;
	const right = b.contribution < 0 ? -b.contribution : b.contribution;
	if (left !== right) return right - left;
	if (a.signal === b.signal) return 0;
	return a.signal < b.signal ? -1 : 1;
}

/**
 * Score one subject from already-ordered, already-filtered log entries.
 *
 * `entries` must be the output of `orderEntries`, `excluded` the output of
 * `collectExclusions` over the same list — both are computed once per call in
 * `scoreSubject` and reused for the standing recursion.
 */
export function computeScore(
	entries: readonly MergedEntry[],
	excluded: ReadonlySet<string>,
	subject: SubjectRef,
	context: ScoringContext
): ScoreResult {
	const { asOf, weightFor, groupOf } = context;
	const target = normalizeSubject(subject);
	const admitted = selectSubjectEntries(entries, excluded, target);
	const facts = extractFacts(admitted, target.domain, asOf);
	const quality = authQuality(facts);

	const groups: SignalGroup[] = [];
	const push = (group: SignalGroup | undefined): void => {
		if (group !== undefined) groups.push(group);
	};
	push(complaintRateSignal(facts, weightFor));
	push(trapHitSignal(facts, weightFor));
	push(authConsistencySignal(facts, quality, weightFor));
	push(historyVolumeSignal(facts, quality, weightFor));
	push(bounceRateSignal(facts, weightFor));
	push(postureSignal(facts, asOf));
	push(vouchSignal(facts, weightFor, context.vouchLoad));
	// Diversity multiplies the observed positive groups, so it is computed last
	// and capped together with them.
	push(diversitySignal(groups, groupOf));
	applyPerObserverCap(groups, groupOf);

	const explanation = groups
		.map((group) => ({
			signal: group.signal,
			contribution: roundTo(contributionOf(group), POLICY_V1.contributionDecimals),
			summary: group.summary,
			evidence: [...group.evidence].sort(compareRefs),
		}))
		.sort(compareGroups);

	// The invariant a consumer can check: the base score plus the *published*
	// contributions rounds to the published score — except where the sum leaves
	// [minScore, maxScore], in which case the score is the clamped bound and the
	// explanation says why it would have gone further.
	let total = POLICY_V1.baseScore;
	for (const group of explanation) total += group.contribution;
	const score = clamp(Math.round(total), POLICY_V1.minScore, POLICY_V1.maxScore);

	return {
		subject: target,
		tier: tierOf(score, groups, groupOf, observedHistoryDays(facts)),
		score,
		policy: POLICY_V1.version,
		explanation,
	};
}
