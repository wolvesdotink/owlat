/**
 * Authenticated v1 body cap (finding M18): `createAuthenticatedHandler` now
 * buffers and size-caps the request body (mirroring the 100 KB public shell) so
 * a key-authed caller can't stream an unbounded body into an action. Drives the
 * extracted `enforceBodyCap` directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { enforceBodyCap, MAX_BODY_BYTES } from '../apiHandlers';
import { TRANSACTIONAL_MAX_BODY_BYTES } from '../../transactional/api';

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

	it('stops reading a chunked body with no Content-Length at the first chunk past the cap', async () => {
		let pulled = 0;
		const chunk = new Uint8Array(64 * 1024);
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(chunk);
			},
		});
		const request = new Request(URL_, { method: 'POST', body, duplex: 'half' } as RequestInit);

		const result = await enforceBodyCap(request, null);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.response.status).toBe(400);
		// 100,000 bytes fit in two 64 KiB chunks: the never-ending stream is
		// abandoned right after, not drained.
		expect(pulled).toBeLessThanOrEqual(3);
	});

	it('honours a route-specific ceiling above the shared cap', async () => {
		const payload = 'x'.repeat(MAX_BODY_BYTES + 1);
		const request = new Request(URL_, { method: 'POST', body: payload });

		const result = await enforceBodyCap(request, null, MAX_BODY_BYTES * 2);

		expect(result.ok).toBe(true);
		if (result.ok) await expect(result.request.text()).resolves.toHaveLength(payload.length);
	});

	it('rejects a streamed body one byte over a route-specific ceiling', async () => {
		const ceiling = 300_000;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(ceiling));
				controller.enqueue(new Uint8Array(1));
				controller.close();
			},
		});
		const request = new Request(URL_, { method: 'POST', body, duplex: 'half' } as RequestInit);

		const result = await enforceBodyCap(request, null, ceiling);

		expect(result.ok).toBe(false);
	});
});

describe('TRANSACTIONAL_MAX_BODY_BYTES', () => {
	it('fits the 10 MiB attachment budget as base64 plus the shared envelope', () => {
		const base64Budget = Math.ceil((10 * 1024 * 1024) / 3) * 4;
		expect(TRANSACTIONAL_MAX_BODY_BYTES).toBeGreaterThanOrEqual(base64Budget + MAX_BODY_BYTES);
	});

	it('stays under the 20 MiB request body Convex accepts for an HTTP action', () => {
		expect(TRANSACTIONAL_MAX_BODY_BYTES).toBeLessThan(20 * 1024 * 1024);
	});
});
