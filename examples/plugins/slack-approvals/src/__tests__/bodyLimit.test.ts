import { describe, expect, it } from 'vitest';
import { MAX_RAW_BODY_BYTES, isRawBodyWithinLimit } from '../bodyLimit';

describe('isRawBodyWithinLimit', () => {
	it('accepts a body exactly at the cap and rejects one byte over', () => {
		expect(isRawBodyWithinLimit('a'.repeat(MAX_RAW_BODY_BYTES))).toBe(true);
		expect(isRawBodyWithinLimit('a'.repeat(MAX_RAW_BODY_BYTES + 1))).toBe(false);
	});

	it('accepts an empty body', () => {
		expect(isRawBodyWithinLimit('')).toBe(true);
	});

	it('counts UTF-8 bytes, not characters (multi-byte code points cost more)', () => {
		// '€' is 3 UTF-8 bytes: a cap/3 + 1 count of them exceeds the byte cap even
		// though its character length is well under it.
		const euros = '€'.repeat(Math.floor(MAX_RAW_BODY_BYTES / 3) + 1);
		expect(euros.length).toBeLessThan(MAX_RAW_BODY_BYTES);
		expect(isRawBodyWithinLimit(euros)).toBe(false);
	});

	it('counts an astral (surrogate-pair) code point as 4 bytes', () => {
		// '😀' is one code point (2 UTF-16 units) = 4 UTF-8 bytes.
		const emoji = '😀'.repeat(Math.floor(MAX_RAW_BODY_BYTES / 4) + 1);
		expect(isRawBodyWithinLimit(emoji)).toBe(false);
	});
});
