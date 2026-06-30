import { describe, it, expect } from 'vitest';
import {
	cosineSimilarity,
	clusterBySimilarity,
	chooseSurvivor,
	mergeContent,
	unionDistinct,
} from '../knowledgeDedup';

describe('cosineSimilarity', () => {
	it('is 1 for identical, 0 for orthogonal, 0 for empty/mismatched', () => {
		expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
		expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
		expect(cosineSimilarity([], [])).toBe(0);
		expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
		expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
	});
	it('is scale-invariant', () => {
		expect(cosineSimilarity([2, 0], [5, 0])).toBeCloseTo(1);
	});
});

describe('clusterBySimilarity', () => {
	const emb = (x: { v: number[] }) => x.v;
	it('groups near-duplicates transitively and isolates distinct items', () => {
		const a = { id: 'a', v: [1, 0, 0] };
		const b = { id: 'b', v: [0.99, 0.01, 0] }; // ~a
		const c = { id: 'c', v: [0, 1, 0] }; // distinct
		const clusters = clusterBySimilarity([a, b, c], emb, 0.95);
		const sizes = clusters.map((g) => g.length).sort();
		expect(sizes).toEqual([1, 2]);
		const dupGroup = clusters.find((g) => g.length === 2)!;
		expect(new Set(dupGroup.map((x) => x.id))).toEqual(new Set(['a', 'b']));
	});
	it('clusters everything alone below threshold', () => {
		const items = [{ v: [1, 0] }, { v: [0, 1] }];
		expect(clusterBySimilarity(items, emb, 0.95)).toHaveLength(2);
	});
});

describe('chooseSurvivor', () => {
	it('keeps the highest confidence, breaking ties by smaller id', () => {
		expect(chooseSurvivor([
			{ id: 'z', confidence: 0.5 },
			{ id: 'a', confidence: 0.9 },
			{ id: 'm', confidence: 0.9 },
		]).id).toBe('a');
	});
	it('is order-independent (converges)', () => {
		const cluster = [
			{ id: 'b', confidence: 0.8 },
			{ id: 'a', confidence: 0.8 },
		];
		expect(chooseSurvivor(cluster).id).toBe('a');
		expect(chooseSurvivor([...cluster].reverse()).id).toBe('a');
	});
});

describe('mergeContent', () => {
	it('appends distinct content, skips subsumed, caps length', () => {
		expect(mergeContent('lives in Berlin', 'Berlin-based')).toBe('lives in Berlin\nBerlin-based');
		expect(mergeContent('lives in Berlin', 'Berlin')).toBe('lives in Berlin'); // subsumed
		expect(mergeContent('lives in Berlin', '   ')).toBe('lives in Berlin'); // empty loser
		expect(mergeContent('x'.repeat(10), 'y'.repeat(10), 12)).toHaveLength(12);
	});
});

describe('unionDistinct', () => {
	it('merges preserving order, dropping duplicates, tolerates undefined', () => {
		expect(unionDistinct(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
		expect(unionDistinct(undefined, ['c'])).toEqual(['c']);
		expect(unionDistinct(['a'], undefined)).toEqual(['a']);
		expect(unionDistinct(undefined, undefined)).toEqual([]);
	});
});
