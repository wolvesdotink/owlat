/**
 * Unit tests for the **Public token endpoint (module)** shell — every
 * cross-cutting concern that used to live in nine open-coded `httpAction`s
 * now lives in one factory, so this file is the test surface for all of
 * them: path matching, CORS preflight, method gate, rate-limit short-
 * circuit, token decode, body parsing, handler-throw, action-mode and
 * outcome-mode result mapping.
 *
 * Tests drive `createShellHandler` directly with a fake `ctx` and a real
 * `Request`. We do not go through `httpAction` — the inner async function
 * is what we care about.
 *
 * See docs/adr/0030-public-token-endpoint-module.md.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	compilePath,
	createShellHandler,
	parseBody,
	type HandlerContext,
} from '../publicTokenEndpoint';

// ─── Test harness ──────────────────────────────────────────────────────────

interface FakeCtxOptions {
	rateLimitOk?: boolean;
	rateLimitRetryAfter?: number;
}

function makeFakeCtx(options: FakeCtxOptions = {}): HandlerContext {
	const { rateLimitOk = true, rateLimitRetryAfter = 0 } = options;
	return {
		runMutation: vi.fn(
			async () => ({ ok: rateLimitOk, retryAfter: rateLimitRetryAfter }),
		) as unknown as HandlerContext['runMutation'],
		runQuery: vi.fn() as unknown as HandlerContext['runQuery'],
		runAction: vi.fn() as unknown as HandlerContext['runAction'],
	};
}

// ─── compilePath ───────────────────────────────────────────────────────────

describe('compilePath', () => {
	it('matches literal segments only', () => {
		const match = compilePath('/confirm/doi');
		expect(match('/confirm/doi')).toEqual({});
		expect(match('/confirm/other')).toBeNull();
		expect(match('/confirm/doi/extra')).toBeNull();
	});

	it('captures named segments', () => {
		const match = compilePath('/unsub/:token');
		expect(match('/unsub/abc123')).toEqual({ token: 'abc123' });
		expect(match('/unsub/')).toBeNull(); // empty token segment ⇒ different arity
	});

	it('captures multiple named segments', () => {
		const match = compilePath('/prefs/update/:token');
		expect(match('/prefs/update/xyz')).toEqual({ token: 'xyz' });
		expect(match('/prefs/verify/xyz')).toBeNull();
	});

	it('rejects pathname with different arity', () => {
		const match = compilePath('/unsub/:token');
		expect(match('/unsub')).toBeNull();
		expect(match('/unsub/abc/extra')).toBeNull();
	});

	it('tolerates leading/trailing slashes', () => {
		const match = compilePath('/share/:token');
		expect(match('share/abc')).toEqual({ token: 'abc' });
		expect(match('/share/abc/')).toEqual({ token: 'abc' });
	});
});

// ─── parseBody ─────────────────────────────────────────────────────────────

describe('parseBody', () => {
	it('returns undefined for mode "none"', async () => {
		const request = new Request('http://x/', { method: 'POST', body: 'whatever' });
		await expect(parseBody(request, 'none')).resolves.toBeUndefined();
	});

	it('parses JSON body for mode "json"', async () => {
		const request = new Request('http://x/', {
			method: 'POST',
			body: JSON.stringify({ a: 1 }),
		});
		await expect(parseBody(request, 'json')).resolves.toEqual({ a: 1 });
	});

	it('throws on invalid JSON in mode "json"', async () => {
		const request = new Request('http://x/', { method: 'POST', body: 'not-json' });
		await expect(parseBody(request, 'json')).rejects.toThrow(/JSON/);
	});

	it('parses urlencoded body for mode "formData"', async () => {
		const request = new Request('http://x/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'name=foo&email=bar%40baz.com',
		});
		await expect(parseBody(request, 'formData')).resolves.toEqual({
			name: 'foo',
			email: 'bar@baz.com',
		});
	});

	it('parses JSON within mode "formData"', async () => {
		const request = new Request('http://x/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ k: 'v' }),
		});
		await expect(parseBody(request, 'formData')).resolves.toEqual({ k: 'v' });
	});

	it('throws on unsupported content-type for mode "formData"', async () => {
		const request = new Request('http://x/', {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain' },
			body: 'foo',
		});
		await expect(parseBody(request, 'formData')).rejects.toThrow();
	});
});

// ─── Shell shape: CORS preflight ───────────────────────────────────────────

describe('shell — CORS preflight', () => {
	it('returns 204 with the declared methods header on OPTIONS', async () => {
		const handler = createShellHandler(
			{
				path: '/unsub/:token',
				method: 'POST',
				rateLimit: 'subscriptionManagement',
				cors: 'POST, OPTIONS',
				resultMode: 'action',
			},
			async () => ({ ok: true, data: {} }),
		);
		const ctx = makeFakeCtx();
		const request = new Request('http://localhost/unsub/abc', { method: 'OPTIONS' });
		const response = await handler(ctx, request);
		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	it('skips CORS preflight when cors:false', async () => {
		const handler = createShellHandler(
			{
				path: '/unsub/:token',
				method: 'POST',
				rateLimit: 'subscriptionManagement',
				cors: false,
				resultMode: 'action',
			},
			async () => ({ ok: true, data: {} }),
		);
		const ctx = makeFakeCtx();
		const request = new Request('http://localhost/unsub/abc', { method: 'OPTIONS' });
		const response = await handler(ctx, request);
		// OPTIONS is not the declared method → 405.
		expect(response.status).toBe(405);
	});
});

// ─── Shell shape: method gate ──────────────────────────────────────────────

describe('shell — method gate', () => {
	it('returns 405 with the locked envelope for wrong method', async () => {
		const handler = createShellHandler(
			{
				path: '/share/:token',
				method: 'GET',
				rateLimit: 'subscriptionManagement',
				cors: 'GET, OPTIONS',
				resultMode: 'action',
			},
			async () => ({ ok: true, data: {} }),
		);
		const ctx = makeFakeCtx();
		const request = new Request('http://localhost/share/abc', { method: 'DELETE' });
		const response = await handler(ctx, request);
		expect(response.status).toBe(405);
		const body = await response.json();
		expect(body).toEqual({
			error: { message: 'Method not allowed' },
		});
	});
});

// ─── Shell shape: rate limit ───────────────────────────────────────────────

describe('shell — rate-limit gate', () => {
	it('short-circuits with 429 and a Retry-After header', async () => {
		const handler = createShellHandler(
			{
				path: '/share/:token',
				method: 'GET',
				rateLimit: 'subscriptionManagement',
				cors: 'GET, OPTIONS',
				resultMode: 'action',
			},
			async () => ({ ok: true, data: {} }),
		);
		const ctx = makeFakeCtx({ rateLimitOk: false, rateLimitRetryAfter: 5000 });
		const request = new Request('http://localhost/share/abc', { method: 'GET' });
		const response = await handler(ctx, request);
		expect(response.status).toBe(429);
		expect(response.headers.get('Retry-After')).toBe('5');
		const body = await response.json();
		expect(body.error.category).toBe('rate_limited');
	});
});

// ─── Shell shape: token extract ────────────────────────────────────────────

describe('shell — token extract', () => {
	it('reads token from a named path segment and URL-decodes it', async () => {
		const seenTokens: string[] = [];
		const handler = createShellHandler(
			{
				path: '/unsub/:token',
				method: 'POST',
				rateLimit: 'subscriptionManagement',
				cors: false,
				resultMode: 'action',
			},
			async (_ctx, { token }) => {
				seenTokens.push(token);
				return { ok: true, data: {} };
			},
		);
		const ctx = makeFakeCtx();
		// %3A = ':' — RFC 8058 token format is `contactId:timestamp:signature`
		const request = new Request('http://localhost/unsub/abc%3A123%3Asig', {
			method: 'POST',
		});
		await handler(ctx, request);
		expect(seenTokens).toEqual(['abc:123:sig']);
	});

	it('falls back to ?token= when the path has no :token segment', async () => {
		const seenTokens: string[] = [];
		const handler = createShellHandler(
			{
				path: '/confirm/doi',
				method: 'POST',
				rateLimit: 'doiConfirmation',
				cors: 'GET, POST, OPTIONS',
				resultMode: 'action',
			},
			async (_ctx, { token }) => {
				seenTokens.push(token);
				return { ok: true, data: {} };
			},
		);
		const ctx = makeFakeCtx();
		const request = new Request('http://localhost/confirm/doi?token=tok123', {
			method: 'POST',
		});
		await handler(ctx, request);
		expect(seenTokens).toEqual(['tok123']);
	});

	it('returns 400 with the locked envelope when no token is present', async () => {
		const handler = createShellHandler(
			{
				path: '/confirm/doi',
				method: 'POST',
				rateLimit: 'doiConfirmation',
				cors: 'GET, POST, OPTIONS',
				resultMode: 'action',
			},
			async () => ({ ok: true, data: {} }),
		);
		const ctx = makeFakeCtx();
		const request = new Request('http://localhost/confirm/doi', { method: 'POST' });
		const response = await handler(ctx, request);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error.category).toBe('invalid_input');
	});
});

// ─── Shell shape: body parsing ─────────────────────────────────────────────

describe('shell — body parsing', () => {
	it('parses JSON body and passes it to the handler', async () => {
		let receivedBody: unknown;
		const handler = createShellHandler(
			{
				path: '/prefs/update/:token',
				method: 'POST',
				rateLimit: 'subscriptionManagement',
				cors: 'POST, OPTIONS',
				body: 'json',
				resultMode: 'action',
			},
			async (_ctx, { body }) => {
				receivedBody = body;
				return { ok: true, data: {} };
			},
		);
		const ctx = makeFakeCtx();
		const request = new Request('http://localhost/prefs/update/abc', {
			method: 'POST',
			body: JSON.stringify({ updates: [{ topicId: 'tA', subscribed: true }] }),
		});
		await handler(ctx, request);
		expect(receivedBody).toEqual({ updates: [{ topicId: 'tA', subscribed: true }] });
	});

	it('returns 400 with the locked envelope on body parse failure', async () => {
		const handler = createShellHandler(
			{
				path: '/prefs/update/:token',
				method: 'POST',
				rateLimit: 'subscriptionManagement',
				cors: 'POST, OPTIONS',
				body: 'json',
				resultMode: 'action',
			},
			async () => ({ ok: true, data: {} }),
		);
		const ctx = makeFakeCtx();
		const request = new Request('http://localhost/prefs/update/abc', {
			method: 'POST',
			body: 'definitely-not-json',
		});
		const response = await handler(ctx, request);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error.category).toBe('invalid_input');
		expect(body.error.message).toMatch(/JSON/);
	});
});

// ─── Shell shape: handler-throw ────────────────────────────────────────────

describe('shell — handler throw', () => {
	it('returns 500 with the locked envelope when the handler throws', async () => {
		const handler = createShellHandler(
			{
				path: '/share/:token',
				method: 'GET',
				rateLimit: 'subscriptionManagement',
				cors: 'GET, OPTIONS',
				resultMode: 'action',
			},
			async () => {
				throw new Error('synthetic failure');
			},
		);
		const ctx = makeFakeCtx();
		const request = new Request('http://localhost/share/abc', { method: 'GET' });
		const response = await handler(ctx, request);
		expect(response.status).toBe(500);
		const body = await response.json();
		expect(body).toEqual({
			error: { category: 'internal', message: 'Internal error' },
		});
	});
});

// ─── Shell shape: action-mode result mapping ───────────────────────────────

describe('shell — action mode', () => {
	it('wraps ok:true in { ok: true, data }', async () => {
		const handler = createShellHandler(
			{
				path: '/share/:token',
				method: 'GET',
				rateLimit: 'subscriptionManagement',
				cors: 'GET, OPTIONS',
				resultMode: 'action',
			},
			async () => ({ ok: true, data: { html: '<p/>' } }),
		);
		const ctx = makeFakeCtx();
		const request = new Request('http://localhost/share/abc', { method: 'GET' });
		const response = await handler(ctx, request);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			data: { html: '<p/>' },
		});
	});

	it('maps ok:false to the locked envelope at the requested status', async () => {
		const handler = createShellHandler(
			{
				path: '/share/:token',
				method: 'GET',
				rateLimit: 'subscriptionManagement',
				cors: 'GET, OPTIONS',
				resultMode: 'action',
			},
			async () => ({
				ok: false,
				reason: 'share_link_not_found',
				message: 'Share link not found',
				status: 404,
			}),
		);
		const ctx = makeFakeCtx();
		const request = new Request('http://localhost/share/abc', { method: 'GET' });
		const response = await handler(ctx, request);
		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			error: {
				category: 'not_found',
				message: 'Share link not found',
				data: { reason: 'share_link_not_found' },
			},
		});
	});

	it('defaults ok:false status to 400 when omitted', async () => {
		const handler = createShellHandler(
			{
				path: '/share/:token',
				method: 'GET',
				rateLimit: 'subscriptionManagement',
				cors: 'GET, OPTIONS',
				resultMode: 'action',
			},
			async () => ({ ok: false, reason: 'invalid_token' }),
		);
		const ctx = makeFakeCtx();
		const request = new Request('http://localhost/share/abc', { method: 'GET' });
		const response = await handler(ctx, request);
		expect(response.status).toBe(400);
	});

	it('passes raw Response through with CORS layered on top', async () => {
		const handler = createShellHandler(
			{
				path: '/forms/:token',
				method: 'POST',
				rateLimit: 'formSubmission',
				cors: 'POST, OPTIONS',
				resultMode: 'action',
			},
			async () => ({
				ok: true,
				raw: new Response(null, {
					status: 302,
					headers: { Location: 'https://example.com/thanks' },
				}),
			}),
		);
		const ctx = makeFakeCtx();
		const request = new Request('http://localhost/forms/abc', { method: 'POST' });
		const response = await handler(ctx, request);
		expect(response.status).toBe(302);
		expect(response.headers.get('Location')).toBe('https://example.com/thanks');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	it('merges custom response headers on success', async () => {
		const handler = createShellHandler(
			{
				path: '/archive/:token',
				method: 'GET',
				rateLimit: 'subscriptionManagement',
				cors: 'GET, OPTIONS',
				resultMode: 'action',
			},
			async () => ({
				ok: true,
				headers: { 'Cache-Control': 'public, max-age=3600' },
				data: { html: '<p/>' },
			}),
		);
		const ctx = makeFakeCtx();
		const request = new Request('http://localhost/archive/abc', { method: 'GET' });
		const response = await handler(ctx, request);
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
	});
});

// ─── Shell shape: outcome-mode result mapping ──────────────────────────────

describe('shell — outcome mode', () => {
	it('returns 200 with ok:true and data when the handler succeeds', async () => {
		const handler = createShellHandler(
			{
				path: '/unsub/verify/:token',
				method: 'GET',
				rateLimit: 'subscriptionManagement',
				cors: 'GET, OPTIONS',
				resultMode: 'outcome',
			},
			async () => ({ ok: true, data: { email: 'x@y.z' } }),
		);
		const ctx = makeFakeCtx();
		const request = new Request('http://localhost/unsub/verify/abc', { method: 'GET' });
		const response = await handler(ctx, request);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			data: { email: 'x@y.z' },
		});
	});

	it('returns 200 with ok:false and reason when the handler reports failure', async () => {
		const handler = createShellHandler(
			{
				path: '/unsub/verify/:token',
				method: 'GET',
				rateLimit: 'subscriptionManagement',
				cors: 'GET, OPTIONS',
				resultMode: 'outcome',
			},
			async () => ({ ok: false, reason: 'expired' }),
		);
		const ctx = makeFakeCtx();
		const request = new Request('http://localhost/unsub/verify/abc', { method: 'GET' });
		const response = await handler(ctx, request);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: false, reason: 'expired' });
	});
});

// ─── Rate-limit key mode (per-recipient token bucketing) ─────────────────────
//
// rateLimitKeyMode: 'ip+token' must mix the token into the rate-limit key so a
// flood on one recipient's link (or, with no trusted proxy, the shared 'unknown'
// IP) cannot exhaust another recipient's bucket. Without a configured proxy
// getClientIp returns 'unknown', so the key becomes 'unknown:<token>'.

describe('rate-limit key mode', () => {
	function makeKeyCapturingCtx(): { ctx: HandlerContext; keys: string[] } {
		const keys: string[] = [];
		const ctx: HandlerContext = {
			runMutation: vi.fn(async (_ref: unknown, args: unknown) => {
				keys.push((args as { key: string }).key);
				return { ok: true, retryAfter: 0 };
			}) as unknown as HandlerContext['runMutation'],
			runQuery: vi.fn() as unknown as HandlerContext['runQuery'],
			runAction: vi.fn() as unknown as HandlerContext['runAction'],
		};
		return { ctx, keys };
	}

	it("ip+token mode gives each token its own bucket key", async () => {
		const handler = createShellHandler(
			{
				path: '/unsub/:token',
				method: 'GET',
				rateLimit: 'subscriptionManagement',
				rateLimitKeyMode: 'ip+token',
				cors: 'GET, OPTIONS',
				resultMode: 'outcome',
			},
			async () => ({ ok: true, data: {} }),
		);
		const { ctx, keys } = makeKeyCapturingCtx();
		await handler(ctx, new Request('http://localhost/unsub/recipientA', { method: 'GET' }));
		await handler(ctx, new Request('http://localhost/unsub/recipientB', { method: 'GET' }));
		expect(keys).toEqual(['unknown:recipientA', 'unknown:recipientB']);
	});

	it('default (ip) mode shares one key regardless of token', async () => {
		const handler = createShellHandler(
			{
				path: '/forms/:token',
				method: 'POST',
				rateLimit: 'formSubmission',
				cors: 'POST, OPTIONS',
				resultMode: 'outcome',
			},
			async () => ({ ok: true, data: {} }),
		);
		const { ctx, keys } = makeKeyCapturingCtx();
		await handler(ctx, new Request('http://localhost/forms/formA', { method: 'POST' }));
		await handler(ctx, new Request('http://localhost/forms/formB', { method: 'POST' }));
		expect(keys).toEqual(['unknown', 'unknown']);
	});
});
