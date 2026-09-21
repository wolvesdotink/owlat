import { describe, it, expect, vi } from 'vitest';
import { runInboundPipeline, type InboundAdapter } from '../pipeline';
import type { ActionCtx } from '../../_generated/server';

/**
 * Pre-auth body cap for the inbound webhook pipeline (M13).
 *
 * The raw body is read BEFORE signature verification, so an unauthenticated
 * caller could otherwise stream an arbitrarily large payload into memory. The
 * pipeline rejects a `Content-Length` beyond the cap without reading a byte, and
 * also caps the bytes actually read (for a chunked request that omits the
 * header). Both must fail closed — 413, and never reach `verifySignature`.
 *
 * Exercised with a hand-rolled ctx + Request so the size gate is deterministic
 * and no rate-limiter / DB harness is needed. The rate-limit mutation is stubbed
 * to always allow, matching the shipped order (limit → size → verify).
 */

const MAX_BYTES = 5 * 1024 * 1024;

function mockCtx(): ActionCtx {
	return {
		runMutation: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
	} as unknown as ActionCtx;
}

function fakeRequest(headers: Record<string, string>, body: string): Request {
	const lower: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
	return {
		method: 'POST',
		url: 'https://deploy.convex.site/webhooks/test',
		headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
		text: async () => body,
	} as unknown as Request;
}

function makeAdapter(): InboundAdapter {
	return {
		source: 'test',
		verifySignature: vi.fn().mockResolvedValue({ ok: false, status: 401, reason: 'unsigned' }),
		parseEvent: () => null,
	};
}

describe('runInboundPipeline body cap (M13)', () => {
	it('rejects (413) a Content-Length over the cap before reading or verifying', async () => {
		const adapter = makeAdapter();
		const res = await runInboundPipeline(
			mockCtx(),
			fakeRequest({ 'Content-Length': String(MAX_BYTES + 1) }, 'x'),
			adapter
		);
		expect(res.status).toBe(413);
		expect(adapter.verifySignature).not.toHaveBeenCalled();
	});

	it('rejects (413) an oversize body when Content-Length is absent (chunked)', async () => {
		const adapter = makeAdapter();
		const big = 'a'.repeat(MAX_BYTES + 1);
		const res = await runInboundPipeline(mockCtx(), fakeRequest({}, big), adapter);
		expect(res.status).toBe(413);
		expect(adapter.verifySignature).not.toHaveBeenCalled();
	});

	it('lets a normal, within-cap body through to signature verification', async () => {
		const adapter = makeAdapter();
		const res = await runInboundPipeline(
			mockCtx(),
			fakeRequest({ 'Content-Length': '11' }, 'hello world'),
			adapter
		);
		// Not blocked by the size gate — reaches verifySignature, which we stubbed
		// to reject with 401.
		expect(res.status).toBe(401);
		expect(adapter.verifySignature).toHaveBeenCalledOnce();
	});
});
