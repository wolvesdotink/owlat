/**
 * Curated-answer precedence for knowledge retrieval.
 *
 * A curated canonical answer (`authority: true`, authored through the FAQ
 * surface as a `policy` / `faq` entry) must OUTRANK a noisy scraped fact that
 * competes with it in the same RRF pool — otherwise "what's your returns
 * policy?" can be grounded on a stray sentence lifted from an old thread instead
 * of the maintained answer.
 *
 * Precedence is applied as a STABLE partition over the already-fused ranking:
 * authoritative-and-live entries float to the front in their existing relative
 * order; everything else keeps its order behind them. It changes only ORDER, not
 * membership — nothing is added or dropped — so it composes with the contact
 * scope filter and the graph annotations that ran before it.
 *
 * The supersede/contradict annotations are honoured, not overridden: an entry
 * the graph marked `_stale` (the target of a newer `supersedes` edge) is NOT
 * promoted even if it is authoritative, so a fresher scraped fact that
 * supersedes an out-of-date policy still wins. This reuses the existing
 * `_stale` signal rather than inventing a second precedence axis.
 */

/**
 * The subset of a scored knowledge entry precedence needs. Kept structural (not
 * tied to the Convex Doc type) so the pure helper is trivially unit-testable and
 * usable from both the action and its tests.
 */
export interface PrecedenceEntry {
	authority?: boolean;
	/** Set by graph expansion when this entry is superseded by a newer fact. */
	_stale?: boolean;
}

/**
 * True when an entry should be promoted ahead of ordinary facts: it is a curated
 * canonical answer AND it has not been superseded by a newer fact.
 */
export function isPrioritizedAuthority(entry: PrecedenceEntry): boolean {
	return entry.authority === true && entry._stale !== true;
}

/**
 * Stable-partition `entries` so live authoritative (curated) entries lead,
 * preserving relative order within each group. Pure; returns a new array.
 */
export function applyAuthorityPrecedence<T extends PrecedenceEntry>(entries: T[]): T[] {
	const authoritative: T[] = [];
	const rest: T[] = [];
	for (const entry of entries) {
		if (isPrioritizedAuthority(entry)) {
			authoritative.push(entry);
		} else {
			rest.push(entry);
		}
	}
	return [...authoritative, ...rest];
}
