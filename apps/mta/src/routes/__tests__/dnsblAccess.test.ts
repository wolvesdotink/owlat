/**
 * The Blocklist lookups routes: the key is verified against Spamhaus's test
 * entry before it is stored, stored sealed, never echoed back, and every change
 * starts a fresh sweep.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';

vi.mock('dns/promises', () => ({ resolve4: vi.fn() }));
vi.mock('../../intelligence/dnsbl.js', () => ({
	runDnsblCheck: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolve4 } from 'dns/promises';
import { createDnsblAccessRoutes } from '../dnsblAccess.js';
import { runDnsblCheck } from '../../intelligence/dnsbl.js';
import { readSpamhausDqsKey, recordSpamhausAccess } from '../../intelligence/dnsblAccess.js';
import type { MtaConfig } from '../../config.js';

const API_KEY = 'test-master-key';
const KEY = 'abcdefghijklmnopqrstuvwxyz';
const config = { apiKey: API_KEY } as unknown as MtaConfig;

function nxdomain(): Error {
	return Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
}

function request(app: ReturnType<typeof createDnsblAccessRoutes>, method: string, body?: unknown) {
	return app.request('/', {
		method,
		headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

describe('dnsbl-access routes', () => {
	let redis: RealRedis;
	let app: ReturnType<typeof createDnsblAccessRoutes>;

	beforeEach(async () => {
		vi.clearAllMocks();
		redis = new Redis() as unknown as RealRedis;
		await redis.flushall();
		app = createDnsblAccessRoutes(redis, config);
	});

	it('requires the master key', async () => {
		expect((await app.request('/', { method: 'GET' })).status).toBe(401);
	});

	it('reports the public mirror and the last sweep outcome', async () => {
		await recordSpamhausAccess(redis, { reason: 'resolver_refused', path: 'system', checkedAt: 5 });
		const res = await request(app, 'GET');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			resolver: { configured: 'system', lastPath: 'system' },
			spamhaus: { access: 'public', status: 'unknown', reason: 'resolver_refused', checkedAt: 5 },
		});
	});

	it('verifies a key against the test entry, stores it, and re-checks', async () => {
		vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
			if (hostname === `2.0.0.127.${KEY}.zen.dq.spamhaus.net`) return ['127.0.0.2'];
			throw nxdomain();
		});
		await recordSpamhausAccess(redis, { reason: 'resolver_refused', path: 'system', checkedAt: 5 });

		const res = await request(app, 'PUT', { spamhausDqsKey: ` ${KEY} ` });
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body).toEqual({
			ok: true,
			access: {
				resolver: { configured: 'system' },
				spamhaus: { access: 'dqs', keyHint: 'wxyz', status: 'pending' },
			},
		});
		expect(JSON.stringify(body)).not.toContain(KEY);
		expect(await readSpamhausDqsKey(redis)).toBe(KEY);
		expect(runDnsblCheck).toHaveBeenCalledOnce();
	});

	it('refuses a key Spamhaus does not answer for, and keeps the old state', async () => {
		vi.mocked(resolve4).mockRejectedValue(nxdomain());
		const res = await request(app, 'PUT', { spamhausDqsKey: KEY });

		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({ ok: false, reason: 'key_rejected' });
		expect(await readSpamhausDqsKey(redis)).toBeUndefined();
		expect(runDnsblCheck).not.toHaveBeenCalled();
	});

	it('refuses something that is not a key without querying anything', async () => {
		const res = await request(app, 'PUT', { spamhausDqsKey: 'not a key' });
		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({ ok: false, reason: 'invalid_key' });
		expect(resolve4).not.toHaveBeenCalled();

		expect((await request(app, 'PUT', { spamhausDqsKey: 42 })).status).toBe(400);
	});

	it('removes the key and goes back to the public mirror', async () => {
		vi.mocked(resolve4).mockResolvedValue(['127.0.0.2']);
		await request(app, 'PUT', { spamhausDqsKey: KEY });

		const res = await request(app, 'PUT', { spamhausDqsKey: null });
		expect(res.status).toBe(200);
		expect((await res.json()).access.spamhaus.access).toBe('public');
		expect(await readSpamhausDqsKey(redis)).toBeUndefined();
		expect(runDnsblCheck).toHaveBeenCalledTimes(2);
	});
});
