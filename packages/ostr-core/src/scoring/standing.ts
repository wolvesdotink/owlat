/**
 * Observer standing (plan §6.3): every attestation is weighted by its author's
 * own standing, because observers are subjects too.
 *
 * RECURSION BOUND — DEPTH 1, BY CONSTRUCTION. Scoring a subject weights its
 * witnesses by scoring each witness as a subject over the same entries; that
 * inner scoring pass uses `POLICY_V1.observerStanding.baseWeight` for *its*
 * witnesses and therefore never asks for standing again. Two passes, always:
 * depth 0 (the caller's subject, standing-weighted witnesses) and depth 1 (each
 * witness, base-weighted witnesses). Deepening the recursion would make the
 * result depend on the shape of the observer graph, which is exactly the
 * circularity the plan rules out — a Sybil ring's mutual weighting must not be
 * able to bootstrap itself.
 *
 * The same bound applies to the audit-finding discount: a finding's author is
 * weighed by its *score-derived* weight only, never by a weight that itself
 * accounts for findings, so "who audits the auditor" terminates immediately.
 * Both weights are memoized per call, so each party is scored at most once.
 */

import type { AuditFindingBody } from '../types.js';
import { computeScore, type ScoringContext } from './engine.js';
import { clamp, daysBetween } from './math.js';
import { POLICY_V1 } from './policy.js';
import { bodyOf, entryKey, normalizeDomain, observerKey, type MergedEntry } from './select.js';
import type { ObserverWeigher } from './signals.js';

const BASE_WEIGHER: ObserverWeigher = () => POLICY_V1.observerStanding.baseWeight;

/** A {@link ScoringContext} without the weigher it is used to build. */
export type BaseContext = Omit<ScoringContext, 'weightFor'>;

/** What the appeal cycle (plan §9.3) owes each party in standing. */
export interface StandingEvents {
	/** Observer key → appeals against its attestations that it never answered. */
	unansweredAppeals: ReadonlyMap<string, number>;
	/** Appellant key → its appeals the named observer substantiated. */
	failedAppeals: ReadonlyMap<string, number>;
}

/**
 * Audit-findings against `party` that count (plan §6.3), as a weight factor.
 *
 * Three bounds, none of which the scaffold had: a finding is only *upheld* once
 * the accused has had the response window to contest it (an excluded finding —
 * retracted, or lost on appeal — never reaches here at all); at most one
 * finding counts per (author control group, finding kind), so filing the same
 * accusation six times is worth one; and each finding's bite is proportional to
 * its author's own standing, so neutralizing an observer costs standing instead
 * of six throwaway records.
 */
function auditPenalty(
	entries: readonly MergedEntry[],
	excluded: ReadonlySet<string>,
	party: string,
	context: BaseContext,
	scoreWeightOf: (party: string) => number
): number {
	const standing = POLICY_V1.observerStanding;
	const counted = new Set<string>();
	let factor = 1;
	for (const entry of entries) {
		if (entry.attestation.kind !== 'audit-finding') continue;
		if (excluded.has(entryKey(entry))) continue;
		if (normalizeDomain(entry.attestation.subject.domain) !== party) continue;
		if (daysBetween(entry.loggedAt, context.asOf) < standing.upheldAfterDays) continue;
		// An observer cannot clear itself: self-authored findings still count,
		// so auditing yourself only ever lowers your own weight.
		const author = observerKey(entry.attestation.observer);
		const key = `${context.groupOf(author)} ${bodyOf<AuditFindingBody>(entry.attestation).finding}`;
		if (counted.has(key)) continue;
		counted.add(key);
		const authority = clamp(scoreWeightOf(author), 0, 1);
		factor *= 1 - (1 - standing.auditFindingPenalty) * authority;
	}
	return factor;
}

/** Repeated application of `penalty`, `times` times. */
function compound(penalty: number, times: number): number {
	let factor = 1;
	for (let i = 0; i < times; i++) factor *= penalty;
	return factor;
}

/**
 * A memoized {@link ObserverWeigher} over a fixed `(entries, excluded, asOf)`
 * snapshot. Pure: the same snapshot always yields the same weights.
 *
 * An observer's weight is its own score relative to the neutral score, clamped,
 * then discounted for upheld audit-findings against it (§6.3) and for appeals
 * it left unanswered (§9.3) — "skin in the game", on the public record. Failed
 * appeals discount the appellant the same way, which is why the weigher is not
 * observer-only: an observer is a party, and so is an appellant.
 */
export function createObserverWeigher(
	entries: readonly MergedEntry[],
	excluded: ReadonlySet<string>,
	context: BaseContext,
	events: StandingEvents
): ObserverWeigher {
	const standing = POLICY_V1.observerStanding;
	const baseContext: ScoringContext = { ...context, weightFor: BASE_WEIGHER };
	const scoreWeights = new Map<string, number>();
	const weights = new Map<string, number>();

	const scoreWeightOf = (party: string): number => {
		const key = observerKey(party);
		const cached = scoreWeights.get(key);
		if (cached !== undefined) return cached;
		const result = computeScore(entries, excluded, { domain: key }, baseContext);
		const weight = clamp(
			result.score / standing.neutralScore,
			standing.minWeight,
			standing.maxWeight
		);
		scoreWeights.set(key, weight);
		return weight;
	};

	return (observer: string): number => {
		const key = observerKey(observer);
		const cached = weights.get(key);
		if (cached !== undefined) return cached;
		// No re-entrance is possible: depth is fixed at 1 by construction, and
		// everything below weighs its own witnesses at the base weight.
		let weight = scoreWeightOf(key);
		weight *= auditPenalty(entries, excluded, key, context, scoreWeightOf);
		const lapses = Math.max(
			(events.unansweredAppeals.get(key) ?? 0) - standing.unansweredAppealGrace,
			0
		);
		weight *= compound(standing.unansweredAppealPenalty, lapses);
		weight *= compound(standing.failedAppealPenalty, events.failedAppeals.get(key) ?? 0);
		const bounded = Math.max(weight, standing.auditPenaltyFloorWeight);
		weights.set(key, bounded);
		return bounded;
	};
}
