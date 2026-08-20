/**
 * Consumer-side re-weighting (plan §3, spec 08 §8.4).
 *
 * The published score is a default, not a mandate. A receiver that does not
 * believe a particular observer can drop that observer's evidence and recompute
 * — locally, from the same open policy, over the same log entries — and nothing
 * in the design lets an aggregator prevent it. That is the whole answer to "who
 * watches the registry": a registry a receiver cannot overrule would be exactly
 * the chokepoint this project exists to remove.
 *
 * The cost is stated with the freedom, because it is real: a re-weighted score
 * is a LOCAL score. It is no longer the reproducible default answer, two
 * consumers with different exclusions are not comparing the same number, and a
 * consumer MUST NOT publish or redistribute one as if it were the aggregator's
 * `ScoreResult` (spec 08 §8.4). The result type here carries `local: true` and
 * the exclusions that produced it so the distinction survives serialization.
 *
 * The arithmetic itself is not reimplemented: entries are filtered and handed
 * to `scoreSubject` from `@owlat/ostr-core`. A consumer running a different
 * policy would not be recomputing the same registry.
 */

import {
	scoreSubject,
	type ObserverGrouper,
	type ScoreResult,
	type SequencedAttestation,
	type SubjectRef,
} from '@owlat/ostr-core';
import { normalizeDomainName, observerMatches } from './subject.js';

/**
 * A consumer's local policy configuration — the shape a caller persists and
 * hands to {@link rescoreWithLocalPolicy}.
 */
export interface ConsumerPolicy {
	/**
	 * Observer domains whose evidence this consumer ignores. An entry covers
	 * the named domain and its subdomains, so `evil.example` also excludes
	 * `mx2.evil.example`.
	 */
	excludeObservers?: string[];
	/**
	 * Reserved for per-observer weight multipliers, the second half of §8.4.
	 * **Not honoured, and not ignored either**: passing a non-empty map makes
	 * {@link rescoreWithLocalPolicy} throw.
	 *
	 * Weights change the shape of the per-observer cap in §6.3, and shipping
	 * them before that interaction is specified would let a consumer quietly
	 * build a score whose bounds no longer hold. Silently dropping them would
	 * be worse still — a receiver would run its published weights and get the
	 * unweighted number, which is exactly the quiet divergence §8.4 warns
	 * about. Exclusion — a weight of zero — is the subset that is safe today.
	 */
	observerWeights?: Record<string, number>;
}

export interface RescoreInput {
	/** Log entries, in any order, exactly as `scoreSubject` takes them. */
	entries: SequencedAttestation[];
	subject: SubjectRef;
	/** RFC 3339 evaluation time. */
	asOf: string;
	/** Observer domains to drop; subdomains of each are dropped with it. */
	excludeObservers?: string[];
	/**
	 * The consumer's persisted policy. Its `excludeObservers` are applied on
	 * top of the ones named directly above, so the caller that keeps a policy
	 * on disk hands the whole object over instead of spreading its optional
	 * fields by hand.
	 */
	policy?: ConsumerPolicy;
	/** Optional control-grouping, passed straight through to the policy. */
	observerGroup?: ObserverGrouper;
}

/** A `ScoreResult` that is explicitly this consumer's, not the aggregator's. */
export interface LocalScoreResult extends ScoreResult {
	/** Always true. A published score never carries it. */
	local: true;
	/**
	 * The exclusions that produced this result, normalized and de-duplicated:
	 * two consumers spelling one exclusion differently emit the same
	 * provenance, and an entry that names no usable domain is dropped rather
	 * than reported as if it had done something.
	 */
	excludedObservers: string[];
}

/** True when `observer` is covered by any exclusion entry. */
export function isObserverExcluded(observer: string, exclusions: readonly string[]): boolean {
	return exclusions.some((exclusion) => observerMatches(observer, exclusion));
}

/**
 * The entries left after dropping every excluded observer's attestations.
 *
 * Exclusion is by author, not by subject: dropping `evil.example` removes what
 * it said about this sender *and* what it said about other observers, which is
 * the point — an observer a consumer does not believe should not be able to
 * influence the standing of the observers it does believe either.
 */
export function filterExcludedObservers(
	entries: readonly SequencedAttestation[],
	exclusions: readonly string[]
): SequencedAttestation[] {
	if (exclusions.length === 0) return [...entries];
	return entries.filter((entry) => !isObserverExcluded(entry.attestation.observer, exclusions));
}

/**
 * Recompute a subject's score under this consumer's local policy.
 *
 * With no exclusions the result is the aggregator's arithmetic exactly — the
 * same function over the same entries — which is what makes a local score
 * auditable against the published one.
 *
 * Throws when the policy carries `observerWeights`: see the field's note. A
 * configuration this function cannot honour is refused out loud.
 */
export function rescoreWithLocalPolicy(input: RescoreInput): LocalScoreResult {
	const weights = input.policy?.observerWeights;
	if (weights !== undefined && Object.keys(weights).length > 0) {
		throw new Error(
			'ConsumerPolicy.observerWeights is not honoured yet (spec 08 §8.4, pending the §6.3 cap interaction); use excludeObservers'
		);
	}
	const exclusions = normalizeExclusions([
		...(input.excludeObservers ?? []),
		...(input.policy?.excludeObservers ?? []),
	]);
	const entries = filterExcludedObservers(input.entries, exclusions);
	const result = scoreSubject({
		entries,
		subject: input.subject,
		asOf: input.asOf,
		...(input.observerGroup === undefined ? {} : { observerGroup: input.observerGroup }),
	});
	return { ...result, local: true, excludedObservers: exclusions };
}

/** Lowercase, de-duplicate, and drop entries that name no usable domain. */
function normalizeExclusions(exclusions: readonly string[]): string[] {
	const kept = new Set<string>();
	for (const exclusion of exclusions) {
		const normalized = normalizeDomainName(exclusion);
		if (normalized !== null) kept.add(normalized);
	}
	return [...kept];
}
