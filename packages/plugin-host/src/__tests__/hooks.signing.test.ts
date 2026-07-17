import { describe, expect, it } from 'vitest';
import { constantTimeEqual, hashHookBody, signHookHmac, verifyHookHmac } from '../hooks/signing';

describe('signHookHmac', () => {
	it('is deterministic for the same secret and data', async () => {
		const a = await signHookHmac('secret', 'data');
		const b = await signHookHmac('secret', 'data');
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it('changes when the secret or data changes', async () => {
		const base = await signHookHmac('secret', 'data');
		expect(await signHookHmac('secret2', 'data')).not.toBe(base);
		expect(await signHookHmac('secret', 'data2')).not.toBe(base);
	});

	it('matches a known RFC-style vector', async () => {
		// HMAC-SHA256(key="key", data="The quick brown fox jumps over the lazy dog")
		expect(await signHookHmac('key', 'The quick brown fox jumps over the lazy dog')).toBe(
			'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'
		);
	});
});

describe('hashHookBody', () => {
	it('is the SHA-256 of the UTF-8 bytes', async () => {
		expect(await hashHookBody('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});
});

describe('constantTimeEqual', () => {
	it('is true only for identical strings', () => {
		expect(constantTimeEqual('abcdef', 'abcdef')).toBe(true);
		expect(constantTimeEqual('abcdef', 'abcdeg')).toBe(false);
	});

	it('is false for different lengths without short-circuiting', () => {
		expect(constantTimeEqual('abc', 'abcdef')).toBe(false);
		expect(constantTimeEqual('abcdef', 'abc')).toBe(false);
	});
});

describe('verifyHookHmac', () => {
	it('accepts a correct signature', async () => {
		const sig = await signHookHmac('secret', 'data');
		expect(await verifyHookHmac('secret', 'data', sig)).toBe(true);
	});

	it('rejects a forged signature', async () => {
		const sig = await signHookHmac('secret', 'data');
		const forged = sig.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
		expect(await verifyHookHmac('secret', 'data', forged)).toBe(false);
	});

	it('rejects a non-hex or empty candidate rather than throwing', async () => {
		expect(await verifyHookHmac('secret', 'data', 'not-hex!!')).toBe(false);
		expect(await verifyHookHmac('secret', 'data', '')).toBe(false);
	});
});
