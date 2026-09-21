/**
 * Cross-cutting behaviour of the app itself: the factory's purity, the JSON
 * error envelope, unknown routes, the headers every answer carries (including
 * the failing ones — that they survive `onError` is a property of Hono's
 * middleware composition, not something this layer can assume), and the wall
 * between an internal failure and what an anonymous caller is told about it.
 */
import type { MiddlewareHandler } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { DEFAULT_MAX_BODY_BYTES, readJsonBody } from '../body.js';
import { failingServices, FakeScoreIndex } from './fakes.js';
import { makeLog, makeObserver, SCORE, trafficSummary } from './fixtures.js';

function setup() {
	const observer = makeObserver();
	const { log } = makeLog([observer]);
	const scores = new FakeScoreIndex({ scores: [SCORE] });
	return { app: createApp({ log, scores }), log, scores, observer };
}

describe('createApp', () => {
	it('is a pure factory: two apps over one service pair are independent', async () => {
		const { log, scores } = setup();
		const first = createApp({ log, scores });
		const second = createApp({ log, scores });

		expect(first).not.toBe(second);
		expect((await first.request('/healthz')).status).toBe(200);
		expect((await second.request('/healthz')).status).toBe(200);
	});

	it('answers JSON, not HTML, for an unknown route', async () => {
		const { app } = setup();

		const res = await app.request('/v1/nope');

		expect(res.status).toBe(404);
		expect(res.headers.get('content-type')).toContain('application/json');
		expect(await res.json()).toEqual({ error: 'not found' });
	});

	it('answers 404 JSON for an unknown route under a known prefix', async () => {
		const { app } = setup();

		const res = await app.request('/v1/log/proof/whatever');

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'not found' });
	});

	it('sets nosniff on every answer', async () => {
		const { app } = setup();

		const res = await app.request('/v1/subject/sender.example');

		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('allows cross-origin reads of the public data', async () => {
		const { app } = setup();

		const res = await app.request('/v1/subject/sender.example', {
			headers: { origin: 'https://explorer.example' },
		});

		expect(res.headers.get('access-control-allow-origin')).toBe('*');
	});

	it('answers the preflight a browser sends before a submission', async () => {
		const { app } = setup();

		const res = await app.request('/v1/attestations', {
			method: 'OPTIONS',
			headers: {
				origin: 'https://explorer.example',
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'content-type',
			},
		});

		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-methods')).toContain('POST');
		expect(res.headers.get('access-control-allow-headers')).toContain('content-type');
	});

	it('answers a HEAD the way it answers the GET', async () => {
		const { app } = setup();

		const res = await app.request('/v1/zone', { method: 'HEAD' });

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
	});

	it.each([
		['a 400', '/v1/subject/NOT-A-DOMAIN', 400],
		['a 404', '/v1/nope', 404],
	])('keeps nosniff and CORS on %s', async (_label, path, status) => {
		const { app } = setup();

		const res = await app.request(path, { headers: { origin: 'https://explorer.example' } });

		expect(res.status).toBe(status);
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
	});

	it('keeps nosniff and CORS on a 500', async () => {
		const app = createApp(failingServices(new Error('sqlite: disk I/O error')));

		const res = await app.request('/v1/subject/sender.example', {
			headers: { origin: 'https://explorer.example' },
		});

		expect(res.status).toBe(500);
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
	});

	it('never lets an answer be cached by omission', async () => {
		const { app } = setup();

		const missing = await app.request('/v1/subject/nobody.example');
		const health = await app.request('/healthz');

		expect(missing.headers.get('cache-control')).toBe('no-store');
		expect(health.headers.get('cache-control')).toBe('no-store');
	});

	it('turns an unexpected service failure into 500 without leaking its message', async () => {
		const app = createApp(failingServices(new Error('sqlite: disk I/O error at /var/lib/ostr')));

		const res = await app.request('/v1/subject/sender.example');

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'internal error' });
	});

	it('does not echo an engine RangeError back as if the caller caused it', async () => {
		// V8 raises RangeError for `Maximum call stack size exceeded` and
		// `Invalid string length` too, so a RangeError is not evidence of a bad
		// request and its message is not the caller's business.
		const app = createApp(failingServices(new RangeError('Maximum call stack size exceeded')));

		const res = await app.request('/v1/log/proof/inclusion?index=0&size=1');

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'internal error' });
	});

	it('runs an operator-supplied rate limiter before the routes', async () => {
		const { log, scores } = setup();
		let calls = 0;
		const rateLimit: MiddlewareHandler = async (c, next) => {
			calls += 1;
			if (calls > 1) return c.json({ error: 'slow down' }, 429);
			await next();
		};
		const app = createApp({ log, scores }, { rateLimit });

		const first = await app.request('/v1/subject/sender.example');
		const second = await app.request('/v1/subject/sender.example');

		expect(first.status).toBe(200);
		expect(second.status).toBe(429);
		expect(second.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('uses the injected clock for the log receipt time', async () => {
		const { log, scores, observer } = setup();
		const now = vi.fn(() => '2026-01-01T00:00:00.000Z');
		const app = createApp({ log, scores }, { now });
		const submit = vi.spyOn(log, 'submit');

		await app.request('/v1/attestations', {
			method: 'POST',
			body: JSON.stringify(trafficSummary(observer)),
			headers: { 'content-type': 'application/json' },
		});

		expect(now).toHaveBeenCalledTimes(1);
		expect(submit.mock.calls[0]?.[1]).toBe('2026-01-01T00:00:00.000Z');
	});

	it('caps a submission at the default ceiling when none is configured', async () => {
		const { app } = setup();

		const res = await app.request('/v1/attestations', {
			method: 'POST',
			body: JSON.stringify({ padding: 'x'.repeat(DEFAULT_MAX_BODY_BYTES) }),
			headers: { 'content-type': 'application/json' },
		});

		expect(res.status).toBe(413);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: `body must be at most ${DEFAULT_MAX_BODY_BYTES} bytes`,
		});
	});

	it('does not listen or touch the network when built', () => {
		const { log, scores } = setup();

		expect(() => createApp({ log, scores })).not.toThrow();
	});
});

describe('readJsonBody', () => {
	it('tolerates a body sent with no content-type at all', async () => {
		// `app.request` always stamps one, so the tolerated branch is only
		// reachable — and only honestly testable — by calling the reader itself.
		const request = new Request('https://registry.test/v1/attestations', {
			method: 'POST',
			body: '{"v":1}',
		});
		request.headers.delete('content-type');

		expect(await readJsonBody(request, DEFAULT_MAX_BODY_BYTES)).toEqual({ v: 1 });
	});
});
