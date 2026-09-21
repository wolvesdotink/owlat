/**
 * `scoreSubject` — the public entry point of `ostr-policy-v1` (plan §6.2).
 *
 * A pure function of `(entries, subject, asOf, observerGroup)`. No clock, no
 * randomness, no I/O: two parties holding the same inputs compute
 * byte-identical `ScoreResult`s, whatever order the entries arrived in.
 */

import type { ScoreResult, SequencedAttestation, SubjectRef } from '../types.js';
import { collectExclusions } from './appeals.js';
import { computeScore, createVouchLoad, type ScoringContext } from './engine.js';
import { defaultObserverGroup, orderEntries, type ObserverGrouper } from './select.js';
import { createObserverWeigher } from './standing.js';

export interface ScoreSubjectInput {
	/** Log entries from any number of logs, in any order. */
	entries: SequencedAttestation[];
	/** The scored subject: a domain (primary) or a bare IP (plan D2/D3). */
	subject: SubjectRef;
	/** RFC 3339 evaluation time. Entries logged after it are not yet visible. */
	asOf: string;
	/**
	 * Optional control-grouping for observers (plan §6.3 "disjoint control").
	 * Must be pure, or the result stops being reproducible. Defaults to
	 * {@link defaultObserverGroup}, which groups by registrable domain and
	 * judges nothing about shared infrastructure; an aggregator holding ASN or
	 * monitor data supplies a better one here.
	 */
	observerGroup?: ObserverGrouper;
}

/**
 * Score `subject` against `entries` as of `asOf`.
 *
 * Ordering, `asOf` visibility and the retraction / vouch-revoke / appeal
 * exclusions are resolved once, up front, and the resulting snapshot is shared
 * with the observer-standing pass — so an attestation excluded for the subject
 * is also excluded when weighing the observer that wrote it.
 */
export function scoreSubject(input: ScoreSubjectInput): ScoreResult {
	const ordered = orderEntries(input.entries, input.asOf);
	const { excluded, unansweredAppeals, failedAppeals } = collectExclusions(ordered, input.asOf);
	const base = {
		asOf: input.asOf,
		groupOf: input.observerGroup ?? defaultObserverGroup,
		vouchLoad: createVouchLoad(ordered, excluded, input.asOf),
	};
	const weightFor = createObserverWeigher(ordered, excluded, base, {
		unansweredAppeals,
		failedAppeals,
	});
	const context: ScoringContext = { ...base, weightFor };
	return computeScore(ordered, excluded, input.subject, context);
}
