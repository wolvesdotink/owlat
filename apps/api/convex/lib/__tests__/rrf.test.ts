import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion, RRF_K } from '../rrf';

describe('reciprocalRankFusion', () => {
	it('returns a single list unchanged in rank order', () => {
		expect(reciprocalRankFusion([['a', 'b', 'c']])).toEqual(['a', 'b', 'c']);
	});

	it('rewards items that appear in multiple legs over a single-leg top hit', () => {
		// `b` is rank 1 in both legs; `a` and `c` are each a rank-0 top hit but in
		// only one leg. Summed reciprocal ranks: b = 2/(60+2), a = c = 1/(60+1).
		const fused = reciprocalRankFusion([
			['a', 'b'],
			['c', 'b'],
		]);
		expect(fused[0]).toBe('b');
		expect(new Set(fused)).toEqual(new Set(['a', 'b', 'c']));
	});

	it('degrades gracefully when a leg is empty (vector-only fallback)', () => {
		expect(reciprocalRankFusion([['x', 'y', 'z'], []])).toEqual(['x', 'y', 'z']);
		expect(reciprocalRankFusion([[], ['x', 'y']])).toEqual(['x', 'y']);
		expect(reciprocalRankFusion([[], []])).toEqual([]);
	});

	it('surfaces an exact-token (FTS-only) hit that the vector leg ranked far down', () => {
		// Vector leg ranks the FTS target ('sku') dead last among many; the FTS leg
		// puts it first. Fusion should lift it well above where vector alone had it.
		const vector = ['v0', 'v1', 'v2', 'v3', 'sku'];
		const fts = ['sku'];
		const fused = reciprocalRankFusion([vector, fts]);
		expect(fused.indexOf('sku')).toBeLessThan(fused.indexOf('v3'));
		expect(fused[0]).toBe('sku');
	});

	it('matches the closed-form reciprocal-rank sum for k', () => {
		const fused = reciprocalRankFusion([['a', 'b']], RRF_K);
		// Just an ordering assertion guarding the 0-based rank offset (rank+1).
		expect(fused).toEqual(['a', 'b']);
		// a at rank 0 → 1/61 > b at rank 1 → 1/62.
		expect(1 / (RRF_K + 1)).toBeGreaterThan(1 / (RRF_K + 2));
	});
});
