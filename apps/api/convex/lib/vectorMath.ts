/**
 * Small pure vector helpers shared across the embedding-driven features
 * (knowledge dedup, graph surprise scoring).
 */

/**
 * Cosine similarity of two equal-length vectors. Returns 0 when either vector is
 * empty, the lengths differ, or either has zero magnitude (an entry without a
 * real embedding), so a missing embedding contributes no (mis)information rather
 * than masquerading as maximally dissimilar.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
	if (a.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
		normA += a[i]! * a[i]!;
		normB += b[i]! * b[i]!;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
