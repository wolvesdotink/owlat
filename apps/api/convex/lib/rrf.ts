/**
 * Reciprocal Rank Fusion (RRF).
 *
 * Merge several independently-ranked lists of the same items into one ranking by
 * summing `1 / (k + rank)` per item across the lists it appears in (rank is
 * 0-based). RRF is *scale-agnostic*: it never compares the underlying scores
 * (cosine similarity vs BM25 relevance live on different scales), only ranks —
 * so the legs need no normalization, and a leg that returns nothing simply
 * contributes nothing (graceful degradation to whatever legs did return).
 *
 * `k` dampens the influence of top ranks; 60 is the canonical constant from the
 * original Cormack et al. RRF paper and the value used across the ecosystem.
 */
export const RRF_K = 60;

/**
 * Fuse ranked id-lists into a single id-list ordered by descending RRF score.
 * Ties keep first-seen order (stable). Items may repeat across input lists; each
 * occurrence adds its reciprocal-rank contribution.
 */
export function reciprocalRankFusion<T>(rankedLists: readonly (readonly T[])[], k: number = RRF_K): T[] {
	const scores = new Map<T, number>();
	for (const list of rankedLists) {
		list.forEach((id, rank) => {
			scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
		});
	}
	return [...scores.keys()].sort((a, b) => scores.get(b)! - scores.get(a)!);
}
