/**
 * Pure helpers for contact-scoped knowledge dedup-merge. A large mailbox import
 * extracts the same fact about one contact many times, phrased differently ("based
 * in Berlin", "lives in Berlin", "Berlin-based") — near-identical embeddings,
 * distinct titles, so the write-level title-idempotency in graph.saveEntry never
 * catches them. These helpers find such clusters and pick a deterministic
 * survivor so the merge converges on re-runs. The Convex wiring (junction/
 * relation repointing, deletion) lives in knowledge/maintenance.ts.
 */

import { cosineSimilarity } from './vectorMath';

/** Cosine threshold above which two entries are considered the same fact. */
export const DEDUP_SIMILARITY_THRESHOLD = 0.95;

/** Cap on merged-content length so a runaway cluster can't bloat one row. */
export const MAX_MERGED_CONTENT_CHARS = 4000;

// Re-exported so callers and tests keep importing it from this module.
export { cosineSimilarity };

/**
 * Group items into near-duplicate clusters by pairwise cosine >= threshold
 * (transitive, via union-find). O(n²) in the item count — callers bound n.
 * Items whose embedding is empty cluster alone (cosine 0 against everything).
 */
export function clusterBySimilarity<T>(
	items: readonly T[],
	embeddingOf: (item: T) => readonly number[],
	threshold: number
): T[][] {
	const parent = items.map((_, i) => i);
	const find = (x: number): number => {
		let root = x;
		while (parent[root] !== root) root = parent[root]!;
		while (parent[x] !== root) {
			const next = parent[x]!;
			parent[x] = root;
			x = next;
		}
		return root;
	};
	const union = (a: number, b: number) => {
		parent[find(a)] = find(b);
	};

	for (let i = 0; i < items.length; i++) {
		for (let j = i + 1; j < items.length; j++) {
			if (cosineSimilarity(embeddingOf(items[i]!), embeddingOf(items[j]!)) >= threshold) {
				union(i, j);
			}
		}
	}

	const groups = new Map<number, T[]>();
	items.forEach((item, i) => {
		const root = find(i);
		const group = groups.get(root);
		if (group) group.push(item);
		else groups.set(root, [item]);
	});
	return [...groups.values()];
}

/**
 * Deterministic survivor of a duplicate cluster: highest confidence wins; ties
 * break to the lexicographically smaller id. Determinism guarantees a re-run
 * picks the same survivor and converges instead of ping-ponging.
 */
export function chooseSurvivor<T extends { confidence: number; id: string }>(
	cluster: readonly T[]
): T {
	return cluster.reduce((best, e) =>
		e.confidence > best.confidence || (e.confidence === best.confidence && e.id < best.id)
			? e
			: best
	);
}

/**
 * Merge a loser's content into the survivor's: skip when the survivor already
 * subsumes it, else append, capped. Keeps the survivor when re-merged.
 */
export function mergeContent(
	survivor: string,
	loser: string,
	cap = MAX_MERGED_CONTENT_CHARS
): string {
	const trimmedLoser = loser.trim();
	const base =
		trimmedLoser === '' || survivor.includes(trimmedLoser)
			? survivor
			: `${survivor}\n${trimmedLoser}`;
	return base.length <= cap ? base : base.slice(0, cap);
}

/** Union two optional id/tag lists, preserving order and dropping duplicates. */
export function unionDistinct<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): T[] {
	const out: T[] = [];
	const seen = new Set<T>();
	for (const x of [...(a ?? []), ...(b ?? [])]) {
		if (!seen.has(x)) {
			seen.add(x);
			out.push(x);
		}
	}
	return out;
}
