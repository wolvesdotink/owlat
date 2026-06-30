/**
 * Knowledge-graph analytics — pure, ctx-free compute helpers.
 *
 * Everything here is deterministic and dependency-free (no Convex `ctx`, no I/O)
 * so the heavy math behind `knowledge/graphAnalytics.ts:recomputeStats` can be
 * unit-tested in isolation and runs cheaply inside a V8 action. The action owns
 * the (typed) pagination + persistence; this module owns the graph math:
 * confidence distribution, approximate communities (label propagation), cosine
 * similarity, and the "surprising connection" score.
 *
 * NONE of this feeds an AI/retrieval path — it backs the member-only analytics
 * dashboard only.
 */

/** Number of confidence histogram buckets over the [0,1] range. */
export const CONFIDENCE_BUCKET_COUNT = 10;

/** Clamp `n` (truncated to an integer) into the inclusive `[lo, hi]` range. */
export function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

/**
 * Surprising-connection score weights (sum to 1): an edge is "surprising" when
 * it joins two SEMANTICALLY distant nodes (w1·(1−cosine)), crosses a community
 * boundary (w2), and links disjoint topic tags (w3). Tuned so semantic distance
 * dominates but structure/tags break ties.
 */
export const SURPRISE_W_DISSIMILARITY = 0.6;
export const SURPRISE_W_CROSS_COMMUNITY = 0.25;
export const SURPRISE_W_TAG_DISJOINT = 0.15;

/**
 * Cosine similarity of two equal-length vectors. Returns 0 when either vector is
 * empty or has zero magnitude (an entry without a real embedding), so a missing
 * embedding contributes no (mis)information to the surprise score rather than
 * masquerading as maximally dissimilar.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
	if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let magA = 0;
	let magB = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i]!;
		const y = b[i]!;
		dot += x * y;
		magA += x * x;
		magB += y * y;
	}
	if (magA === 0 || magB === 0) return 0;
	return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export interface ConfidenceStats {
	/** Per-bucket counts over [0,1]; length === CONFIDENCE_BUCKET_COUNT; sums to values.length. */
	buckets: number[];
	mean: number;
	median: number;
}

/**
 * Bucket a set of 0–1 confidence scores into {@link CONFIDENCE_BUCKET_COUNT}
 * equal-width buckets and compute mean + median. Values are clamped to [0,1], so
 * every value lands in exactly one bucket and `sum(buckets) === values.length`
 * (the invariant the dashboard's "buckets sum to nodeCount" assertion relies on).
 * Empty input yields all-zero buckets and mean/median 0.
 */
export function confidenceStats(values: readonly number[]): ConfidenceStats {
	const buckets: number[] = Array.from({ length: CONFIDENCE_BUCKET_COUNT }, () => 0);
	if (values.length === 0) return { buckets, mean: 0, median: 0 };

	let sum = 0;
	for (const v of values) {
		const clamped = v < 0 ? 0 : v > 1 ? 1 : v;
		sum += clamped;
		const idx = Math.min(CONFIDENCE_BUCKET_COUNT - 1, Math.floor(clamped * CONFIDENCE_BUCKET_COUNT));
		buckets[idx] = (buckets[idx] ?? 0) + 1;
	}

	const sorted = [...values].map((v) => (v < 0 ? 0 : v > 1 ? 1 : v)).sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;

	return { buckets, mean: sum / values.length, median };
}

/**
 * Approximate community detection by synchronous LABEL PROPAGATION over an
 * undirected adjacency map. Leiden/Louvain are too heavy for a V8 action, so we
 * use LPA (graphify labels its communities "approximate" for the same reason).
 *
 * Each node starts as its own community (label === its id). For a fixed number of
 * iterations we sweep nodes in ascending-id order and each node adopts the label
 * held by the plurality of its neighbours, breaking ties toward the
 * lexicographically smallest label. Updates are applied in place during the sweep
 * (synchronous), and the sweep order is fixed, so the result is fully
 * DETERMINISTIC for identical input — re-running on the same graph yields the
 * same labelling (and therefore the same community count). Converges early when a
 * sweep changes nothing.
 */
export function labelPropagation(
	nodeIds: readonly string[],
	adjacency: ReadonlyMap<string, ReadonlySet<string>>,
	iterations: number,
): Map<string, string> {
	const order = [...nodeIds].sort();
	const labels = new Map<string, string>();
	for (const id of order) labels.set(id, id);

	for (let iter = 0; iter < iterations; iter++) {
		let changed = false;
		for (const id of order) {
			const neighbours = adjacency.get(id);
			if (!neighbours || neighbours.size === 0) continue;

			const counts = new Map<string, number>();
			for (const n of neighbours) {
				const lab = labels.get(n);
				if (lab === undefined) continue;
				counts.set(lab, (counts.get(lab) ?? 0) + 1);
			}
			if (counts.size === 0) continue;

			// Plurality label, tie-break to the smallest label id (deterministic):
			// iterate labels in ascending order and keep the first STRICT maximum.
			let best = labels.get(id)!;
			let bestCount = -1;
			for (const lab of [...counts.keys()].sort()) {
				const c = counts.get(lab)!;
				if (c > bestCount) {
					bestCount = c;
					best = lab;
				}
			}
			if (best !== labels.get(id)) {
				labels.set(id, best);
				changed = true;
			}
		}
		if (!changed) break;
	}
	return labels;
}

/**
 * Sizes of every community in a label map, descending. The distinct-label count
 * is `result.length`; the largest communities come first.
 */
export function communitySizesFromLabels(labels: ReadonlyMap<string, string>): number[] {
	const sizes = new Map<string, number>();
	for (const lab of labels.values()) sizes.set(lab, (sizes.get(lab) ?? 0) + 1);
	return [...sizes.values()].sort((a, b) => b - a);
}

/**
 * Do two nodes carry DISJOINT topic tags — both tagged, with no tag in common?
 * Used as the `tagDisjoint` signal in the surprise score: a connection between
 * two differently-tagged nodes is more surprising. Returns false when either node
 * is untagged (absence of tags is not evidence of a topic jump).
 */
export function tagsDisjoint(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (!a || a.length === 0 || !b || b.length === 0) return false;
	const bset = new Set(b);
	return !a.some((t) => bset.has(t));
}

/**
 * Surprise score for one edge from its three signals. Higher = more surprising.
 * `dissimilarity` is `1 − cosine(embA, embB)` (0 when an embedding is missing).
 */
export function surprisingScore(opts: {
	dissimilarity: number;
	crossCommunity: boolean;
	tagDisjoint: boolean;
}): number {
	return (
		SURPRISE_W_DISSIMILARITY * opts.dissimilarity +
		SURPRISE_W_CROSS_COMMUNITY * (opts.crossCommunity ? 1 : 0) +
		SURPRISE_W_TAG_DISJOINT * (opts.tagDisjoint ? 1 : 0)
	);
}
