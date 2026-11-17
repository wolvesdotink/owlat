import { beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { createDomainBlocklistRoutes } from '../domainBlocklists.js';
import type { MtaConfig } from '../../config.js';

const API_KEY = 'test-master-key';
const config = { apiKey: API_KEY } as MtaConfig;

describe('domain blocklist routes', () => {
	let app: ReturnType<typeof createDomainBlocklistRoutes>;

	beforeEach(async () => {
		const redis = new Redis() as unknown as RealRedis;
		await redis.flushall();
		app = createDomainBlocklistRoutes(redis, config);
	});

	const post = (body: unknown, auth = true) =>
		app.request('/', {
			method: 'POST',
			headers: {
				...(auth ? { Authorization: `Bearer ${API_KEY}` } : {}),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});

	it('refuses a name that is not a domain, and too many of them', async () => {
		expect((await post({ domains: ['not a domain'] })).status).toBe(400);
		expect((await post({ domains: ['192.0.2.1'] })).status).toBe(400);
		const many = Array.from({ length: 11 }, (_, index) => `d${index}.example.com`);
		expect((await post({ domains: many })).status).toBe(400);
	});

	it('requires the master key', async () => {
		expect((await post({ domains: [] }, false)).status).toBe(401);
	});
});
