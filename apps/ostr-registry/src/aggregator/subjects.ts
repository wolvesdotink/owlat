/**
 * Subject universe discovery (plan D2/D3).
 *
 * The aggregator does not get a list of subjects; it derives one from the log.
 * Every entry names a subject, and each named subject expands to the scored
 * identity D2 defines for it:
 *
 *  - a bare domain (`d=` identity, D3) — the primary subject, and the identity
 *    every entry carrying a domain belongs to, whether or not it also named an
 *    address;
 *  - a bare IP, but only from evidence that presented no domain, because
 *    evidence carrying a domain belongs to that domain.
 *
 * There is deliberately no `(ip, domain)` pair subject. D2 separability is real
 * — a shared address's tenants do stay apart — but it lives in the policy's
 * *evidence selection*, not in a distinct scored identity: `selectSubjectEntries`
 * ignores `target.ip` whenever `target.domain` is set, so a pair subject scores
 * byte-identically to its bare domain for every address, including one that
 * never appeared in the log. Materializing it would publish two rows per
 * pair-naming subject — traffic summaries normally name both — doubling the
 * snapshot, the diff feed and the cost of a refresh in exchange for an alias.
 *
 * Identity normalization is the scoring policy's, not ours: two spellings of
 * one IPv6 address or one domain must collapse exactly the way `scoreSubject`
 * collapses them, or the materialized view would key on identities the policy
 * does not recognize. `@owlat/ostr-core/scoring` does not export
 * `normalizeSubject`, so we obtain it from the policy itself by scoring the
 * subject against an empty entry set: `ScoreResult.subject` is the normalized
 * form, the call is pure, and it cannot drift from the policy. It is, however,
 * ~20x the cost of the underlying function and it binds this key to whatever a
 * future policy decides `ScoreResult.subject` means — so discovery memoizes it
 * per call, and core owes us `normalizeSubject` as a public export.
 */

import { canonicalize } from '@owlat/ostr-core';
import { scoreSubject } from '@owlat/ostr-core/scoring';
import type { SequencedAttestation, SubjectRef } from '@owlat/ostr-core';

/**
 * `asOf` for the normalization-only scoring call. Any instant works — the
 * entry set is empty — so it is a constant rather than a clock read.
 */
const NORMALIZATION_EPOCH = '1970-01-01T00:00:00Z';

/** The scoring policy's normalized form of `subject` (lowercased domain, canonical IP literal). */
export function canonicalSubject(subject: SubjectRef): SubjectRef {
	return scoreSubject({ entries: [], subject, asOf: NORMALIZATION_EPOCH }).subject;
}

/**
 * Stable storage/lookup key for a subject: the RFC 8785 canonical JSON of its
 * normalized form. Reusing JCS keeps one canonicalization in the system, and
 * the key sorts deterministically, which is what the snapshot ordering needs.
 */
export function subjectKey(subject: SubjectRef): string {
	return canonicalize(canonicalSubject(subject));
}

/** True when a subject names something scorable at all (D2: a domain or an IP). */
export function isScorableSubject(subject: SubjectRef): boolean {
	return subject.domain !== undefined || subject.ip !== undefined;
}

/** One identity to score, with the entries that named it directly. */
export interface DiscoveredSubject {
	/** Normalized subject. */
	subject: SubjectRef;
	/** {@link subjectKey} of `subject`. */
	key: string;
	/**
	 * Log indexes of the entries whose own subject is exactly this identity,
	 * ascending. This is the *naming* relation and deliberately not the
	 * evidence set: it is unfiltered by `asOf` visibility and by the policy's
	 * exclusions, so a retracted or not-yet-visible entry appears here. What
	 * fed a score is the score's own explanation.
	 */
	entryIndexes: number[];
}

/** The identity one entry's subject expands to, per D2. */
function expand(subject: SubjectRef): SubjectRef[] {
	const domain = subject.domain;
	if (domain !== undefined) return [{ domain }];
	const ip = subject.ip;
	if (ip !== undefined) return [{ ip }];
	return [];
}

/** Normalized identity plus its storage key. */
interface Identity {
	subject: SubjectRef;
	key: string;
}

/**
 * Memoized normalizer for one discovery pass. Logs repeat subjects heavily —
 * every window an observer reports names the same domain — and normalization
 * runs the whole scoring pipeline, so the cache turns a per-entry cost into a
 * per-identity one. It lives no longer than the call, so it cannot grow with
 * the process.
 */
function createNormalizer(): (subject: SubjectRef) => Identity {
	const cache = new Map<string, Identity>();
	return (subject) => {
		const raw = canonicalize(subject);
		const hit = cache.get(raw);
		if (hit !== undefined) return hit;
		const normalized = canonicalSubject(subject);
		const identity: Identity = { subject: normalized, key: canonicalize(normalized) };
		cache.set(raw, identity);
		return identity;
	};
}

/**
 * Every scored identity in `entries`, deduplicated by normalized identity and
 * ordered by key, so two aggregators holding the same log prefix walk the
 * universe in the same order.
 *
 * Discovery is content-neutral and unfiltered — it cannot see the policy's
 * `asOf` visibility or its exclusions — so it over-names by construction. The
 * caller drops the identities the policy admitted no evidence for; a subject
 * that survives only because of an invisible or retracted entry must not reach
 * a published surface (spec 08 §8.1).
 */
export function discoverSubjects(entries: readonly SequencedAttestation[]): DiscoveredSubject[] {
	const normalize = createNormalizer();
	const found = new Map<string, { subject: SubjectRef; entryIndexes: Set<number> }>();
	for (const entry of entries) {
		for (const candidate of expand(entry.attestation.subject)) {
			const identity = normalize(candidate);
			if (!isScorableSubject(identity.subject)) continue;
			const seen = found.get(identity.key);
			if (seen === undefined) {
				found.set(identity.key, {
					subject: identity.subject,
					entryIndexes: new Set([entry.index]),
				});
				continue;
			}
			seen.entryIndexes.add(entry.index);
		}
	}
	return [...found.entries()]
		.map(([key, value]) => ({
			subject: value.subject,
			key,
			entryIndexes: [...value.entryIndexes].sort((a, b) => a - b),
		}))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
