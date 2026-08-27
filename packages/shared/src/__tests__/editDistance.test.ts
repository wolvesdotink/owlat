/**
 * The shared near-miss primitive (src/editDistance.ts). Both the inbound
 * look-alike heuristic and the composer's outbound typo hint read the bound, so
 * the exact distances of the canonical examples are pinned here.
 */
import { describe, it, expect } from 'vitest';
import { boundedEditDistance, LOOKALIKE_MAX_EDITS } from '../editDistance';

describe('boundedEditDistance', () => {
	it('is zero for identical strings', () => {
		expect(boundedEditDistance('paypal.com', 'paypal.com', 2)).toBe(0);
		expect(boundedEditDistance('', '', 2)).toBe(0);
	});

	it('counts substitutions, insertions and deletions', () => {
		expect(boundedEditDistance('paypa1.com', 'paypal.com', 2)).toBe(1);
		expect(boundedEditDistance('gmai.com', 'gmail.com', 2)).toBe(1);
		expect(boundedEditDistance('gmaill.com', 'gmail.com', 2)).toBe(1);
	});

	it('scores a transposition as the two edits Levenshtein sees', () => {
		expect(boundedEditDistance('gmial.com', 'gmail.com', 2)).toBe(2);
	});

	it('returns max + 1 rather than the true distance once the bound is passed', () => {
		expect(boundedEditDistance('northwind.studio', 'gmail.com', 2)).toBe(3);
		expect(boundedEditDistance('abcdef', 'uvwxyz', 3)).toBe(4);
	});

	it('short-circuits on a length gap wider than the bound', () => {
		// 'a' vs a 10-char string is 10 edits apart; the bound answers first.
		expect(boundedEditDistance('a', 'aaaaaaaaaa', 2)).toBe(3);
	});

	it('is symmetric', () => {
		expect(boundedEditDistance('web.de', 'gmx.de', 4)).toBe(
			boundedEditDistance('gmx.de', 'web.de', 4)
		);
	});

	it('keeps the look-alike bound at two edits', () => {
		expect(LOOKALIKE_MAX_EDITS).toBe(2);
	});
});
