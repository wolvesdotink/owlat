import { beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { createIspProfileRoutes } from '../ispProfiles.js';
import type { MtaConfig } from '../../config.js';

const API_KEY = 'test-master-key';
const config = { apiKey: API_KEY } as MtaConfig;

function request(
	app: ReturnType<typeof createIspProfileRoutes>,
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

describe('destination-provider profile routes', () => {
	let app: ReturnType<typeof createIspProfileRoutes>;

	beforeEach(() => {
		const redis = new Redis() as unknown as RealRedis;
		app = createIspProfileRoutes(redis, config);
	});

	it('accepts a valid bounded profile update', async () => {
		const response = await request(app, 'PUT', '/gmail', {
			defaultRate: 120,
			ceiling: 400,
			floor: 10,
			backoffFactor: 0.4,
			recoveryFactor: 1.1,
			tlsMode: 'require',
			maxConnections: 8,
			maxDeliveriesPerConnection: 100,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			provider: 'gmail',
			profile: { defaultRate: 120, tlsMode: 'require', maxConnections: 8 },
		});
	});

	it.each([
		['negative rate', { defaultRate: -1 }],
		['fractional connection limit', { maxConnections: 1.5 }],
		['invalid TLS mode', { tlsMode: 'sometimes' }],
		['unknown field', { magicLimit: 12 }],
	])('rejects %s', async (_caseName, body) => {
		const response = await request(app, 'PUT', '/gmail', body);
		expect(response.status).toBe(400);
	});

	it('rejects a non-finite JSON numeric literal', async () => {
		const response = await app.request('/gmail', {
			method: 'PUT',
			headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
			body: '{"defaultRate":1e309}',
		});
		expect(response.status).toBe(400);
	});

	it('rejects a Gmail TLS downgrade below the checked-in required floor', async () => {
		const response = await request(app, 'PUT', '/gmail', { tlsMode: 'opportunistic' });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: expect.stringContaining('minimum') });
	});

	it.each(['GET', 'PUT', 'DELETE'])('rejects an unknown provider for %s', async (method) => {
		const response = await request(
			app,
			method,
			'/attacker.example',
			method === 'PUT' ? {} : undefined
		);
		expect(response.status).toBe(400);
	});
});
