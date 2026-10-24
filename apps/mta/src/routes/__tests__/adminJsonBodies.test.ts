/**
 * The master-key admin routes decode their JSON bodies before acting on them.
 *
 * Each of these bodies used to arrive through `c.req.json<T>()`, a type
 * argument that checks nothing: a numeric domain reached `.toLowerCase()` and
 * answered 500, a `null` organization was stored as a credential's tenant, and
 * a malformed body threw out of the handler. Every case here asserts the
 * controlled 400 AND that nothing was written to Redis.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import type { Hono } from 'hono';
import type { MtaConfig } from '../../config.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../webhooks/convexNotifier.js', () => ({ notifyConvex: vi.fn(async () => true) }));

const { createCredentialRoutes } = await import('../credentials.js');
const { createDkimRoutes } = await import('../dkim.js');
const { createMailboxRoutes } = await import('../mailboxes.js');
const { createSuppressionRoutes } = await import('../suppression.js');
const { createOrgLimitsRoutes } = await import('../orgLimits.js');
const { createInboundRoutes } = await import('../inboundRoutes.js');
const { createPoolRulesRoutes } = await import('../poolRules.js');
const { createOutboundTlsRoutes } = await import('../outboundTls.js');

const API_KEY = 'test-master-key';
const config = { apiKey: API_KEY } as unknown as MtaConfig;

function send(app: Hono, method: string, path: string, body?: string): Promise<Response> {
	return Promise.resolve(
		app.request(path, {
			method,
			headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
			body,
		})
	);
}

let redis: RealRedis;

beforeEach(() => {
	redis = new Redis() as unknown as RealRedis;
});

afterEach(async () => {
	await redis.flushall();
});

async function expectRefusedWithoutWrites(response: Response): Promise<string> {
	expect(response.status).toBe(400);
	expect(await redis.keys('*')).toEqual([]);
	return ((await response.json()) as { error: string }).error;
}

describe('POST /credentials', () => {
	it.each([
		['a null organization', { organizationId: null, name: 'Key' }],
		['a numeric name', { organizationId: 'org-1', name: 7 }],
		[
			'an allowedDomains entry that is not a string',
			{ organizationId: 'org-1', name: 'Key', allowedDomains: ['a.example', 3] },
		],
	])('refuses %s', async (_name, body) => {
		const app = createCredentialRoutes(redis, config);
		const error = await expectRefusedWithoutWrites(
			await send(app, 'POST', '/', JSON.stringify(body))
		);
		expect(error).toMatch(/^Invalid request body: \$\./);
	});

	it('refuses a malformed body with a 400 instead of throwing', async () => {
		const app = createCredentialRoutes(redis, config);
		await expectRefusedWithoutWrites(await send(app, 'POST', '/', '{"organizationId":'));
	});

	it('still creates a credential from a well-formed body', async () => {
		const app = createCredentialRoutes(redis, config);
		const res = await send(
			app,
			'POST',
			'/',
			JSON.stringify({ organizationId: 'org-1', name: 'Key', allowedDomains: ['a.example'] })
		);
		expect(res.status).toBe(200);
	});
});

describe('/dkim', () => {
	it('refuses a numeric domain on POST / without storing a key', async () => {
		const app = createDkimRoutes(redis, config);
		await expectRefusedWithoutWrites(
			await send(app, 'POST', '/', JSON.stringify({ domain: 7, selector: 's1', privateKey: 'k' }))
		);
	});

	it('keeps the historic body-less rotate and refuses a malformed one', async () => {
		const app = createDkimRoutes(redis, config);
		const malformed = await send(app, 'POST', '/brand.example/rotate', 'selector=s2');
		await expectRefusedWithoutWrites(malformed);

		const bodyLess = await send(app, 'POST', '/brand.example/rotate');
		expect(bodyLess.status).toBe(200);
		expect(await bodyLess.json()).toMatchObject({ rotation: 'immediate' });
	});

	it('refuses a returnPathHost of the wrong type on register', async () => {
		const app = createDkimRoutes(redis, config);
		await expectRefusedWithoutWrites(
			await send(app, 'POST', '/brand.example/register', JSON.stringify({ returnPathHost: 5 }))
		);
	});

	it('refuses a non-boolean force on activate', async () => {
		const app = createDkimRoutes(redis, config);
		await expectRefusedWithoutWrites(
			await send(app, 'POST', '/brand.example/rotation/activate', JSON.stringify({ force: 'yes' }))
		);
	});
});

describe('other admin bodies', () => {
	it('refuses a mailbox cache entry whose quota is a string', async () => {
		const app = createMailboxRoutes(redis, config);
		await expectRefusedWithoutWrites(
			await send(
				app,
				'POST',
				'/cache/alice@example.com',
				JSON.stringify({ mailboxId: 'm1', organizationId: 'org-1', quotaBytes: '10' })
			)
		);
	});

	it('refuses a bulk suppression entry with an unknown reason', async () => {
		const app = createSuppressionRoutes(redis, config);
		await expectRefusedWithoutWrites(
			await send(
				app,
				'POST',
				'/bulk',
				JSON.stringify({ entries: [{ email: 'a@example.com', reason: 'spite' }] })
			)
		);
	});

	it('refuses a suppression list holding a number', async () => {
		const app = createSuppressionRoutes(redis, config);
		await expectRefusedWithoutWrites(
			await send(app, 'POST', '/', JSON.stringify({ emails: ['a@example.com', 1] }))
		);
	});

	it('refuses an org limit sent as a string', async () => {
		const app = createOrgLimitsRoutes(redis, config);
		await expectRefusedWithoutWrites(
			await send(app, 'POST', '/', JSON.stringify({ organizationId: 'org-1', dailyLimit: '100' }))
		);
	});

	it('refuses an inbound route whose address is not a string', async () => {
		const app = createInboundRoutes(redis, config);
		await expectRefusedWithoutWrites(
			await send(
				app,
				'POST',
				'/',
				JSON.stringify({ domain: 'brand.example', address: ['*'], mode: 'accept' })
			)
		);
	});

	it('refuses a pool rule naming an unknown pool', async () => {
		const app = createPoolRulesRoutes(redis, config);
		await expectRefusedWithoutWrites(
			await send(app, 'POST', '/', JSON.stringify({ organizationId: 'org-1', pool: 'bulk' }))
		);
	});

	it('answers a body-less outbound-TLS override with its own required-fields message', async () => {
		const app = createOutboundTlsRoutes(redis, config);
		const error = await expectRefusedWithoutWrites(await send(app, 'POST', '/'));
		expect(error).toBe('domain and mode are required');
	});
});
