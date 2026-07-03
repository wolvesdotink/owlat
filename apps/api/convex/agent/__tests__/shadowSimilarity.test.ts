import { describe, it, expect } from 'vitest';
import { draftSimilarity } from '../shadowSimilarity';

describe('draftSimilarity', () => {
	it('is 1.0 for identical drafts', () => {
		const d = 'Thanks for reaching out — happy to help with your order.';
		expect(draftSimilarity(d, d)).toBe(1);
	});

	it('is 1.0 for drafts differing only in whitespace/case', () => {
		expect(
			draftSimilarity('Thanks for reaching out', '  thanks   for reaching   out  '),
		).toBe(1);
	});

	it('treats two empty drafts as a perfect match', () => {
		expect(draftSimilarity('', '   ')).toBe(1);
	});

	it('is 0.0 for a blank vs. a non-blank draft', () => {
		expect(draftSimilarity('', 'Thanks for your message')).toBe(0);
	});

	it('stays high for a trivial one-word edit in a long draft', () => {
		const a = 'Thanks for reaching out we will ship your order on Monday morning';
		const b = 'Thanks for reaching out we will ship your order on Tuesday morning';
		expect(draftSimilarity(a, b)).toBeGreaterThan(0.9);
	});

	it('drops well below the match bar for a materially rewritten draft', () => {
		const a = 'Thanks for reaching out — happy to help with your order.';
		const b = 'We cannot process this request; please contact billing directly.';
		expect(draftSimilarity(a, b)).toBeLessThan(0.5);
	});

	it('is symmetric', () => {
		const a = 'one two three four five';
		const b = 'one two three four six';
		expect(draftSimilarity(a, b)).toBeCloseTo(draftSimilarity(b, a));
	});
});
