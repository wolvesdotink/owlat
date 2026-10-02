import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';

/**
 * The upload service routes (`/storage/upload/{begin,finish,abort}`) take the
 * instance secret as a bearer token from the web server. A failed compare is
 * charged to the caller's per-IP `uploadServiceSecret` bucket and a matching
 * secret is never charged. The operator routes (`/sample-data/*`) charge their
 * own `instanceSecret` bucket, so they never spend the upload budget. For a resolved client address the bucket is read before the
 * compare, so an exhausted address waits even with the right secret; the shared
 * `'unknown'` bucket is never read first, so upload bursts are not stalled.
 */

const modules = import.meta.glob('../**/*.*s');
const SECRET = 'upload-service-throttle-test-secret';
const ROUTES = ['/storage/upload/begin', '/storage/upload/finish', '/storage/upload/abort'];

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', SECRET);
	vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'xforwarded');
});
afterEach(() => vi.unstubAllEnvs());

function harness(): TestConvex<typeof schema> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

function post(
	t: TestConvex<typeof schema>,
	path: string,
	bearer: string | null,
	ip?: string
): Promise<Response> {
	return t.fetch(path, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }),
			...(ip ? { 'X-Forwarded-For': ip } : {}),
		},
		// Authenticated requests stop at input validation; nothing is minted.
		body: JSON.stringify({}),
	});
}

describe('upload service routes: failed-secret throttle', () => {
	it('answers 429 once one address keeps presenting a wrong secret', async () => {
		const t = harness();
		const statuses: number[] = [];
		for (let i = 0; i < 40; i++) {
			const res = await post(t, ROUTES[i % ROUTES.length]!, 'wrong-secret', '198.51.100.20');
			statuses.push(res.status);
			if (res.status === 429) {
				expect(res.headers.get('Retry-After')).toMatch(/^\d+$/);
				break;
			}
		}
		expect(statuses[statuses.length - 1]).toBe(429);
		expect(statuses.slice(0, -1).every((s) => s === 401)).toBe(true);

		// A missing bearer counts as a failure too.
		expect((await post(t, ROUTES[0]!, null, '198.51.100.20')).status).toBe(429);
		// Another address keeps its own budget.
		expect((await post(t, ROUTES[0]!, 'wrong-secret', '198.51.100.21')).status).toBe(401);
	});

	it('answers 429 to the matching secret from an exhausted real address', async () => {
		const t = harness();
		for (let i = 0; i < 40; i++) {
			if ((await post(t, ROUTES[0]!, 'wrong-secret', '198.51.100.40')).status === 429) break;
		}
		// The bucket is read before the compare, so the right secret waits too.
		expect((await post(t, ROUTES[0]!, SECRET, '198.51.100.40')).status).toBe(429);
		// Another address is unaffected.
		expect((await post(t, ROUTES[0]!, SECRET, '198.51.100.41')).status).toBe(400);
	});

	it('lets the matching secret through the shared unknown bucket even when it is exhausted', async () => {
		const t = harness();
		for (let i = 0; i < 40; i++) {
			if ((await post(t, ROUTES[0]!, 'wrong-secret')).status === 429) break;
		}
		expect((await post(t, ROUTES[0]!, 'wrong-secret')).status).toBe(429);
		// Every caller without a resolvable address shares 'unknown', the web
		// server included, so that bucket is only charged, never read first.
		for (let i = 0; i < 30; i++) {
			expect((await post(t, ROUTES[i % ROUTES.length]!, SECRET)).status).toBe(400);
		}
	});

	it('does not charge a burst of authenticated requests', async () => {
		const t = harness();
		for (let i = 0; i < 60; i++) {
			expect((await post(t, ROUTES[i % ROUTES.length]!, SECRET, '198.51.100.30')).status).toBe(400);
		}
		expect((await post(t, ROUTES[0]!, 'wrong-secret', '198.51.100.30')).status).toBe(401);
	});

	it('keeps the upload budget apart from the operator routes', async () => {
		const t = harness();
		const operatorStatus = (secret: string) =>
			t.fetch('/sample-data/status', {
				method: 'POST',
				headers: { 'X-Instance-Secret': secret, 'X-Forwarded-For': '198.51.100.50' },
			});
		// Use up the operator bucket for one address.
		let operator = 0;
		for (let i = 0; i < 40; i++) {
			operator = (await operatorStatus('wrong-secret')).status;
			if (operator === 429) break;
		}
		expect(operator).toBe(429);
		// The same address can still reach the upload routes.
		expect((await post(t, ROUTES[0]!, SECRET, '198.51.100.50')).status).toBe(400);
		expect((await post(t, ROUTES[0]!, 'wrong-secret', '198.51.100.50')).status).toBe(401);

		// Using up the upload budget leaves that address's operator bucket alone.
		for (let i = 0; i < 40; i++) {
			if ((await post(t, ROUTES[0]!, 'wrong-secret', '198.51.100.51')).status === 429) break;
		}
		expect((await post(t, ROUTES[0]!, SECRET, '198.51.100.51')).status).toBe(429);
		const fresh = await t.fetch('/sample-data/status', {
			method: 'POST',
			headers: { 'X-Instance-Secret': 'wrong-secret', 'X-Forwarded-For': '198.51.100.51' },
		});
		expect(fresh.status).toBe(401);
	});
});
