/**
 * The quote normalization grounding and the reader share: composed and
 * decomposed spellings normalize alike over whole combining sequences, and
 * the offset map leads every normalized unit back to its raw range.
 */
import { describe, expect, it } from 'vitest';
import { normalizeForQuote, normalizeWithMap } from '../quoteNormalize';

describe('quoteNormalize', () => {
	it('normalizes composed and decomposed spellings alike', () => {
		const text = 'Café and Café and Cafȩ́';
		const { normalized } = normalizeWithMap(text);
		expect(normalized.split('Café').length - 1).toBe(2);
		expect(normalizeForQuote('Café')).toBe('Café');
	});

	it('maps a normalized match back to the raw range, marks included', () => {
		const text = 'see Café now';
		const hay = normalizeWithMap(text);
		const at = hay.normalized.indexOf('Café');
		expect(text.slice(hay.from[at], hay.to[at + 3])).toBe('Café');
	});

	it('folds quotes, dashes, invisible characters and whitespace', () => {
		expect(normalizeForQuote('  “ﬁnal” offer —\n\tnow​ ')).toBe('"final" offer - now');
	});
});
