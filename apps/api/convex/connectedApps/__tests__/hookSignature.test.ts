/**
 * Canonical HMAC signing + constant-time verification for signed synchronous
 * hooks, exercised with REAL Web Crypto (no mocks). Proves the wire contract an
 * independent app implementation must interoperate with, and the replay/tamper
 * defenses: a response signature is bound to the REQUEST nonce and the exact
 * response bytes, and the two directions are domain-separated.
 */

import { describe, expect, it } from 'vitest';
import {
	generateHookNonce,
	signHookRequest,
	signHookResponse,
	verifyHookResponseSignature,
	type HookSignatureFields,
} from '../hookSignature';

const SECRET = 'cah_test-shared-secret';
const encode = (s: string) => new TextEncoder().encode(s);

function fields(overrides: Partial<HookSignatureFields> = {}): HookSignatureFields {
	return {
		hookKind: 'gate',
		connectedAppId: 'app_123',
		nonce: 'nonce-abc',
		timestampSeconds: 1_700_000_000,
		bodyBytes: encode('{"outcome":"no-objection"}'),
		...overrides,
	};
}

describe('generateHookNonce', () => {
	it('produces distinct, URL-safe, non-empty nonces', () => {
		const a = generateHookNonce();
		const b = generateHookNonce();
		expect(a).not.toBe(b);
		expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(a.length).toBeGreaterThan(0);
	});
});

describe('request signing', () => {
	it('is deterministic and version-prefixed', async () => {
		const sig = await signHookRequest(SECRET, fields());
		expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
		expect(await signHookRequest(SECRET, fields())).toBe(sig);
	});

	it('changes when any signed field changes', async () => {
		const base = await signHookRequest(SECRET, fields());
		expect(await signHookRequest(SECRET, fields({ nonce: 'other' }))).not.toBe(base);
		expect(await signHookRequest(SECRET, fields({ timestampSeconds: 1 }))).not.toBe(base);
		expect(await signHookRequest(SECRET, fields({ hookKind: 'draft' }))).not.toBe(base);
		expect(await signHookRequest(SECRET, fields({ connectedAppId: 'other' }))).not.toBe(base);
		expect(await signHookRequest(SECRET, fields({ bodyBytes: encode('x') }))).not.toBe(base);
		expect(await signHookRequest('other-secret', fields())).not.toBe(base);
	});

	it('domain-separates request from response — the two signatures differ', async () => {
		const request = await signHookRequest(SECRET, fields());
		const response = await signHookResponse(SECRET, fields());
		expect(request).not.toBe(response);
	});
});

describe('response verification', () => {
	it('accepts a signature produced by the shared secret over the same fields', async () => {
		const f = fields();
		const signature = await signHookResponse(SECRET, f);
		expect(await verifyHookResponseSignature(SECRET, f, signature)).toBe(true);
	});

	it('rejects a wrong secret, a tampered body, and a mismatched nonce (replay)', async () => {
		const f = fields();
		const signature = await signHookResponse(SECRET, f);
		expect(await verifyHookResponseSignature('wrong-secret', f, signature)).toBe(false);
		expect(
			await verifyHookResponseSignature(SECRET, { ...f, bodyBytes: encode('tampered') }, signature)
		).toBe(false);
		// A response captured for nonce A cannot verify against request nonce B.
		expect(await verifyHookResponseSignature(SECRET, { ...f, nonce: 'different' }, signature)).toBe(
			false
		);
	});

	it('rejects a missing/empty/malformed signature header (fail closed)', async () => {
		const f = fields();
		expect(await verifyHookResponseSignature(SECRET, f, null)).toBe(false);
		expect(await verifyHookResponseSignature(SECRET, f, undefined)).toBe(false);
		expect(await verifyHookResponseSignature(SECRET, f, '')).toBe(false);
		expect(await verifyHookResponseSignature(SECRET, f, 'garbage')).toBe(false);
	});
});
