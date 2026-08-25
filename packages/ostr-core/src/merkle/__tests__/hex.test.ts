/**
 * The hex/bytes seam: published documents carry hex, the proof machinery takes
 * digests, and `Buffer.from(x, 'hex')` truncates rather than failing.
 */

import { describe, expect, it } from 'vitest';
import { sha256 } from '../../crypto.js';
import { parseHash, toHex } from '../hex.js';

const digest = sha256('ostr');

describe('parseHash', () => {
	it('round-trips a published digest', () => {
		expect(parseHash(toHex(digest))).toEqual(digest);
	});

	it('refuses what Buffer.from would silently truncate or fold', () => {
		// Each of these produces a short or wrong buffer under Buffer.from.
		for (const value of [
			toHex(digest).slice(0, 63),
			`${toHex(digest)}00`,
			'z'.repeat(64),
			toHex(digest).toUpperCase(),
			` ${toHex(digest)}`,
			'',
			123,
			null,
			undefined,
			Buffer.from(digest),
		]) {
			expect(parseHash(value)).toBeUndefined();
		}
	});
});

describe('toHex', () => {
	it('publishes lowercase hex', () => {
		expect(toHex(digest)).toBe(digest.toString('hex'));
		expect(toHex(digest)).toMatch(/^[0-9a-f]{64}$/);
	});

	it('refuses to publish a digest of the wrong length', () => {
		expect(() => toHex(Buffer.alloc(31))).toThrow(RangeError);
		expect(() => toHex(Buffer.alloc(33))).toThrow(RangeError);
		expect(() => toHex(Buffer.alloc(0))).toThrow(RangeError);
	});
});
