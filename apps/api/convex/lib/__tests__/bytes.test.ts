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
	bytesToBase64,
	bytesToBinaryString,
	utf8ByteLength,
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

describe('utf8ByteLength', () => {
	it('counts bytes, not characters', () => {
		expect(utf8ByteLength('owl')).toBe(3);
		expect(utf8ByteLength('🦉')).toBe(4);
		expect('🦉'.length).toBe(2); // the under-count `.length` would have given
	});

	it('agrees with Buffer.byteLength', () => {
		const text = 'Grüße aus der Hinterland-Kamera 🦉 — ünïcodé';

		expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text, 'utf-8'));
	});
});
