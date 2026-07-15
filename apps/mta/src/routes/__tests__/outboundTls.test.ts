/**
 * Behaviour of the per-domain outbound TLS override routes (T1).
 *
 * Drives the real Hono app over an ioredis-mock so the master-key gate,
 * validation, and Redis-hash persistence run end to end, and asserts the stored
 * override changes what {@link resolveOutboundTlsMode} returns for a domain.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { createOutboundTlsRoutes } from '../outboundTls.js';
import { resolveOutboundTlsMode } from '../../smtp/outboundTlsOverrides.js';
import type { MtaConfig } from '../../config.js';

const API_KEY = 'test-master-key';
const config = { apiKey: API_KEY, outboundTlsMode: 'opportunistic' } as unknown as MtaConfig;

function authedRequest(
	app: ReturnType<typeof createOutboundTlsRoutes>,
	method: string,
	path: string,
	body?: unknown
): Promise<Response> {
	return app.request(path, {
		method,
		headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

describe('outbound-tls override routes', () => {
	let redis: RealRedis;
	let app: ReturnType<typeof createOutboundTlsRoutes>;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
		app = createOutboundTlsRoutes(redis, config);
	});

	it('rejects an unauthenticated request', async () => {
		const res = await app.request('/', { method: 'GET' });
		expect(res.status).toBe(401);
	});

	it('sets, lists, and applies a per-domain override', async () => {
		const set = await authedRequest(app, 'POST', '/', {
			domain: 'Partner.EXAMPLE',
			mode: 'require-verified',
		});
		expect(set.status).toBe(200);
		expect(await set.json()).toMatchObject({
			success: true,
			domain: 'partner.example',
			mode: 'require-verified',
		});

		const list = await authedRequest(app, 'GET', '/');
		expect(await list.json()).toEqual({
			globalMode: 'opportunistic',
			overrides: { 'partner.example': 'require-verified' },
		});

		// The stored override changes the resolved mode; an unset domain falls back.
		expect(await resolveOutboundTlsMode(redis, 'partner.example', 'opportunistic')).toBe(
			'require-verified'
		);
		expect(await resolveOutboundTlsMode(redis, 'other.example', 'opportunistic')).toBe(
			'opportunistic'
		);
	});

	it('rejects an invalid mode', async () => {
		const res = await authedRequest(app, 'POST', '/', {
			domain: 'x.example',
			mode: 'require_verified',
		});
		expect(res.status).toBe(400);
	});

	it('requires both domain and mode', async () => {
		const res = await authedRequest(app, 'POST', '/', { domain: 'x.example' });
		expect(res.status).toBe(400);
	});

	it('removes an override (404 when none)', async () => {
		await authedRequest(app, 'POST', '/', { domain: 'p.example', mode: 'require' });
		const del = await authedRequest(app, 'DELETE', '/p.example');
		expect(del.status).toBe(200);
		const missing = await authedRequest(app, 'DELETE', '/p.example');
		expect(missing.status).toBe(404);
	});
});
