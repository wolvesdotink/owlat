/**
 * The byte/string conversions that stand in for Node's `Buffer` in the Convex
 * V8 runtime.
 *
 * These run under vitest in Node, where `Buffer` exists — so the cases below
 * pin BEHAVIOUR against what `Buffer` did at the call sites they replaced,
 * rather than trusting that the isolate and Node agree. The runtime split
 * itself is guarded statically by `scripts/check-convex-node-globals.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
	base64ToBytes,
	base64UrlToBytes,
	bytesToBase64,
	bytesToBase64Url,
	bytesToBinaryString,
	bytesToHex,
	utf8Bytes,
	utf8CharWidth,
	utf8ToBase64,
} from '../bytes';

/** One conversion chunk in `bytes.ts`, plus change — the overflow boundary. */
const OVER_ONE_CHUNK = 0x8000 + 257;

describe('bytesToBase64', () => {
	it('losslessly encodes byte arrays larger than one conversion chunk', () => {
		const bytes = Uint8Array.from({ length: OVER_ONE_CHUNK }, (_, index) => index % 256);

		const encoded = bytesToBase64(bytes);

		expect(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))).toEqual(bytes);
	});

	it('agrees with Buffer for every byte value', () => {
		const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);

		expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
	});

	it('encodes empty input as the empty string', () => {
		expect(bytesToBase64(new Uint8Array(0))).toBe('');
	});
});

describe('base64url', () => {
	it('matches Buffer and round-trips every byte value without padding', () => {
		const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
		const encoded = bytesToBase64Url(bytes);

		expect(encoded).toBe(Buffer.from(bytes).toString('base64url'));
		expect(encoded).not.toContain('=');
		expect(base64UrlToBytes(encoded)).toEqual(bytes);
	});
});

describe('bytesToHex', () => {
	it('matches Buffer for typed arrays and ArrayBuffers', () => {
		const bytes = Uint8Array.from([0, 15, 255, 16, 171]);
		expect(bytesToHex(bytes)).toBe(Buffer.from(bytes).toString('hex'));
		expect(bytesToHex(bytes.buffer)).toBe(Buffer.from(bytes).toString('hex'));
	});
});

describe('base64ToBytes', () => {
	it('round-trips arbitrary bytes through bytesToBase64', () => {
		const bytes = Uint8Array.from({ length: OVER_ONE_CHUNK }, (_, index) => (index * 7) % 256);

		expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
	});

	it('decodes what Buffer.from(value, base64) decodes', () => {
		const encoded = Buffer.from('Subject: hí\r\n\r\nbody', 'utf8').toString('base64');

		expect(base64ToBytes(encoded)).toEqual(new Uint8Array(Buffer.from(encoded, 'base64')));
	});

	it('tolerates the CRLF wrapping that wire payloads arrive with', () => {
		const bytes = Uint8Array.from({ length: 300 }, (_, index) => index % 256);
		const wrapped = bytesToBase64(bytes).replace(/(.{76})/g, '$1\r\n');

		expect(base64ToBytes(wrapped)).toEqual(bytes);
	});

	it('restores missing padding rather than throwing, as Buffer did', () => {
		const unpadded = bytesToBase64(new TextEncoder().encode('owl')).replace(/=+$/, '');

		expect(new TextDecoder().decode(base64ToBytes(unpadded))).toBe('owl');
	});

	it('yields an empty array for input that cannot be decoded at all', () => {
		expect(base64ToBytes('!!!!')).toEqual(new Uint8Array(0));
	});

	it('decodes the URL-SAFE alphabet instead of shifting every byte after it', () => {
		// Dropping `-`/`_` rather than translating them decodes to something
		// plausible and WRONG, which is worse than refusing the input.
		for (const value of ['-_-_AP8', 'a-b_cd']) {
			expect(base64ToBytes(value), value).toEqual(new Uint8Array(Buffer.from(value, 'base64')));
		}
	});

	it('stops at the first padding character, so trailing junk cannot extend it', () => {
		expect(base64ToBytes('aGVsbG8=Zm9v')).toEqual(
			new Uint8Array(Buffer.from('aGVsbG8=Zm9v', 'base64'))
		);
	});

	it('drops a trailing orphan character instead of failing the whole string', () => {
		expect(base64ToBytes('aGVsb')).toEqual(new Uint8Array(Buffer.from('aGVsb', 'base64')));
	});

	it('matches Buffer over random payloads in both alphabets', () => {
		for (let seed = 1; seed <= 200; seed++) {
			const bytes = Uint8Array.from(
				{ length: (seed % 50) + 1 },
				(_, i) => (seed * 31 + i * 7) % 256
			);
			for (const encoding of ['base64', 'base64url'] as const) {
				const encoded = Buffer.from(bytes).toString(encoding);
				expect(base64ToBytes(encoded), encoded).toEqual(
					new Uint8Array(Buffer.from(encoded, 'base64'))
				);
			}
		}
	});
});

describe('bytesToBinaryString', () => {
	it('maps each byte to one character, matching Buffer latin1', () => {
		const bytes = Uint8Array.from({ length: OVER_ONE_CHUNK }, (_, index) => index % 256);

		const binary = bytesToBinaryString(bytes);

		expect(binary).toHaveLength(bytes.length);
		expect(binary).toBe(Buffer.from(bytes).toString('latin1'));
	});
});

describe('utf8ToBase64', () => {
	it('encodes non-ASCII text as UTF-8 bytes, not UTF-16 code units', () => {
		expect(utf8ToBase64('Grüße 🦉')).toBe(Buffer.from('Grüße 🦉', 'utf-8').toString('base64'));
	});
});

describe('utf8Bytes', () => {
	it('encodes UTF-8 bytes, not UTF-16 code units', () => {
		const text = 'Grüße aus der Hinterland-Kamera 🦉 — ünïcodé';

		expect(utf8Bytes(text)).toEqual(new Uint8Array(Buffer.from(text, 'utf-8')));
		expect(utf8Bytes(text).byteLength).toBe(Buffer.byteLength(text, 'utf-8'));
	});
});

describe('utf8CharWidth', () => {
	it('gives each code point its UTF-8 byte width without encoding it', () => {
		for (const character of ['a', '\u0000', '\u007f', 'ü', 'ß', '€', '한', '🦉', '𝄞']) {
			expect(utf8CharWidth(character), character).toBe(Buffer.byteLength(character, 'utf-8'));
		}
	});

	it('charges a lone surrogate the three bytes U+FFFD costs, as the encoder does', () => {
		const loneSurrogate = '\ud83e';

		expect(utf8CharWidth(loneSurrogate)).toBe(3);
		expect(utf8CharWidth(loneSurrogate)).toBe(Buffer.byteLength(loneSurrogate, 'utf-8'));
	});

	it('sums to the encoded length over a mixed string', () => {
		const text = 'owl 🦉 Grüße — €';
		const summed = [...text].reduce((total, character) => total + utf8CharWidth(character), 0);

		expect(summed).toBe(Buffer.byteLength(text, 'utf-8'));
	});
});
