import { beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { createProviderHoldRoutes } from '../providerHolds.js';
import type { MtaConfig } from '../../config.js';

const API_KEY = 'test-master-key';
const config = { apiKey: API_KEY } as MtaConfig;

describe('provider hold routes', () => {
	let redis: RealRedis;
	let app: ReturnType<typeof createProviderHoldRoutes>;

	beforeEach(async () => {
		redis = new Redis() as unknown as RealRedis;
		await redis.flushall();
		app = createProviderHoldRoutes(redis, config);
	});

	const put = (body: unknown) =>
		app.request('/', {
			method: 'PUT',
			headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});

	it('replaces the held addresses of a provider and lets them lapse on their own', async () => {
		await redis.sadd('mta:provider-hold:microsoft', '192.0.2.9');

		const response = await put({ provider: 'microsoft', ips: ['192.0.2.10', '2001:db8::10'] });

		expect(response.status).toBe(200);
		expect((await redis.smembers('mta:provider-hold:microsoft')).sort()).toEqual([
			'192.0.2.10',
			'2001:db8::10',
		]);
		expect(await redis.ttl('mta:provider-hold:microsoft')).toBeGreaterThan(0);
	});

	it('an empty list lifts every hold of the provider', async () => {
		await redis.sadd('mta:provider-hold:microsoft', '192.0.2.10');

		expect((await put({ provider: 'microsoft', ips: [] })).status).toBe(200);

		expect(await redis.exists('mta:provider-hold:microsoft')).toBe(0);
	});

	it('refuses an unknown provider and an address that is not one', async () => {
		expect((await put({ provider: 'aol', ips: [] })).status).toBe(400);
		expect((await put({ provider: 'microsoft', ips: ['not-an-ip'] })).status).toBe(400);
	});

	it('requires the master key', async () => {
		const response = await app.request('/', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'microsoft', ips: [] }),
		});
		expect(response.status).toBe(401);
	});
});
