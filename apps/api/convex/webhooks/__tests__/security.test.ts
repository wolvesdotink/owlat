import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
	constantTimeEqual,
	bytesToHex,
	bytesToBase64,
	hmacSha256Hex,
	hmacSha256Base64,
	hmacSha1Base64,
} from '../security';

describe('constantTimeEqual', () => {
	it('returns true for identical strings', () => {
		expect(constantTimeEqual('', '')).toBe(true);
		expect(constantTimeEqual('a', 'a')).toBe(true);
		expect(
			constantTimeEqual(
				'67a6479f7b6000f050577eea8b6b5e71d3c704e73a5f5d2aa09f607fce35cf1a',
				'67a6479f7b6000f050577eea8b6b5e71d3c704e73a5f5d2aa09f607fce35cf1a'
			)
		).toBe(true);
	});

	it('returns false for strings of equal length that differ', () => {
		expect(constantTimeEqual('abc', 'abd')).toBe(false);
		// differ only in the first character
		expect(constantTimeEqual('Xbc', 'abc')).toBe(false);
		// differ only in the last character
		expect(constantTimeEqual('abc', 'abC')).toBe(false);
	});

	it('returns false for length mismatches', () => {
		expect(constantTimeEqual('abc', 'abcd')).toBe(false);
		expect(constantTimeEqual('abcd', 'abc')).toBe(false);
		expect(constantTimeEqual('', 'a')).toBe(false);
		expect(constantTimeEqual('a', '')).toBe(false);
		// prefix match but different length must NOT be treated as equal
		expect(constantTimeEqual('secret', 'secret-extra')).toBe(false);
	});
});

describe('bytesToHex', () => {
	it('converts bytes to lowercase zero-padded hex', () => {
		const buf = new Uint8Array([0x00, 0x0f, 0xff, 0x10, 0xab]).buffer;
		expect(bytesToHex(buf)).toBe('000fff10ab');
	});

	it('returns an empty string for empty input', () => {
		expect(bytesToHex(new Uint8Array([]).buffer)).toBe('');
	});

	it('round-trips through a hex parse back to the original bytes', () => {
		const original = new Uint8Array([1, 2, 3, 250, 0, 128, 255]);
		const hex = bytesToHex(original.buffer);
		const parsed = new Uint8Array(
			(hex.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16))
		);
		expect(Array.from(parsed)).toEqual(Array.from(original));
	});
});

describe('bytesToBase64', () => {
	it('encodes bytes to standard base64', () => {
		// "Man" -> "TWFu"
		const buf = new Uint8Array([0x4d, 0x61, 0x6e]).buffer;
		expect(bytesToBase64(buf)).toBe('TWFu');
	});

	it('returns an empty string for empty input', () => {
		expect(bytesToBase64(new Uint8Array([]).buffer)).toBe('');
	});

	it('round-trips through atob back to the original bytes', () => {
		const original = new Uint8Array([0, 1, 2, 3, 254, 255, 100, 200]);
		const b64 = bytesToBase64(original.buffer);
		const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		expect(Array.from(decoded)).toEqual(Array.from(original));
	});

	it('matches node:crypto base64 output for the same bytes', () => {
		const bytes = new Uint8Array([222, 173, 190, 239]); // 0xDEADBEEF
		expect(bytesToBase64(bytes.buffer)).toBe(
			Buffer.from(bytes).toString('base64')
		);
	});
});

describe('hmacSha256Hex', () => {
	const secret = 'topsecret';
	const data = 'hello world';

	it('matches a known precomputed vector', async () => {
		await expect(hmacSha256Hex(secret, data)).resolves.toBe(
			'67a6479f7b6000f050577eea8b6b5e71d3c704e73a5f5d2aa09f607fce35cf1a'
		);
	});

	it('cross-checks against node:crypto', async () => {
		const expected = createHmac('sha256', secret).update(data).digest('hex');
		await expect(hmacSha256Hex(secret, data)).resolves.toBe(expected);
	});

	it('produces a different digest when the secret changes', async () => {
		const a = await hmacSha256Hex('secret-a', data);
		const b = await hmacSha256Hex('secret-b', data);
		expect(a).not.toBe(b);
	});

	it('produces a different digest when the data changes', async () => {
		const a = await hmacSha256Hex(secret, 'payload-a');
		const b = await hmacSha256Hex(secret, 'payload-b');
		expect(a).not.toBe(b);
	});
});

describe('hmacSha256Base64', () => {
	const secret = 'topsecret';
	const data = 'hello world';

	it('matches a known precomputed vector', async () => {
		await expect(hmacSha256Base64(secret, data)).resolves.toBe(
			'Z6ZHn3tgAPBQV37qi2tecdPHBOc6X10qoJ9gf841zxo='
		);
	});

	it('cross-checks against node:crypto for a string secret', async () => {
		const expected = createHmac('sha256', secret)
			.update(data)
			.digest('base64');
		await expect(hmacSha256Base64(secret, data)).resolves.toBe(expected);
	});

	it('cross-checks against node:crypto for a Uint8Array secret', async () => {
		const keyBytes = new Uint8Array([10, 20, 30, 40, 50]);
		const expected = createHmac('sha256', Buffer.from(keyBytes))
			.update(data)
			.digest('base64');
		await expect(hmacSha256Base64(keyBytes, data)).resolves.toBe(expected);
	});

	it('treats a string secret and its byte encoding identically', async () => {
		const fromString = await hmacSha256Base64(secret, data);
		const fromBytes = await hmacSha256Base64(
			new TextEncoder().encode(secret),
			data
		);
		expect(fromString).toBe(fromBytes);
	});
});

describe('hmacSha1Base64', () => {
	const secret = 'topsecret';
	const data = 'hello world';

	it('matches a known precomputed vector', async () => {
		await expect(hmacSha1Base64(secret, data)).resolves.toBe(
			'8lutVAYB/zExc24kpI3ZKPqczJM='
		);
	});

	it('cross-checks against node:crypto', async () => {
		const expected = createHmac('sha1', secret).update(data).digest('base64');
		await expect(hmacSha1Base64(secret, data)).resolves.toBe(expected);
	});

	it('differs from the SHA-256 digest of the same input', async () => {
		const sha1 = await hmacSha1Base64(secret, data);
		const sha256 = await hmacSha256Base64(secret, data);
		expect(sha1).not.toBe(sha256);
	});
});
