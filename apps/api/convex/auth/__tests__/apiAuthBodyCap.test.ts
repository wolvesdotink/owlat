/**
 * Authenticated v1 body cap (finding M18): `createAuthenticatedHandler` now
 * buffers and size-caps the request body (mirroring the 100 KB public shell) so
 * a key-authed caller can't stream an unbounded body into an action. Drives the
 * extracted `enforceBodyCap` directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { enforceBodyCap } from '../apiAuth';

// enforceBodyCap builds a CORS-aware error Response via the shared helpers; the
// loopback origin default keeps that off the production fail-closed path.
beforeEach(() => {
	vi.stubEnv('OWLAT_DEV_MODE', 'true');
});
afterEach(() => {
	vi.unstubAllEnvs();
});

const URL_ = 'https://example.com/api/v1/transactional';

describe('enforceBodyCap', () => {
	it('passes a bodyless GET straight through', async () => {
		const request = new Request(URL_, { method: 'GET' });
		const result = await enforceBodyCap(request, null);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.request).toBe(request);
	});

	it('accepts a small POST body and the re-wrapped request is still readable', async () => {
		const payload = JSON.stringify({ email: 'a@b.com' });
		const request = new Request(URL_, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: payload,
		});
		const result = await enforceBodyCap(request, null);
		expect(result.ok).toBe(true);
		if (result.ok) {
			// The wrapped handler reads the body via request.json() — must survive.
			await expect(result.request.json()).resolves.toEqual({ email: 'a@b.com' });
		}
	});

	it('rejects an oversized body (buffered) with a 400', async () => {
		const big = 'x'.repeat(100_001);
		const request = new Request(URL_, { method: 'POST', body: big });
		const result = await enforceBodyCap(request, null);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.response.status).toBe(400);
	});

	it('rejects on an oversized Content-Length header before buffering', async () => {
		// A lying/oversized Content-Length short-circuits without reading the body.
		const request = new Request(URL_, {
			method: 'POST',
			headers: { 'Content-Length': String(100_001) },
			body: 'small',
		});
		const result = await enforceBodyCap(request, null);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.response.status).toBe(400);
	});
});
