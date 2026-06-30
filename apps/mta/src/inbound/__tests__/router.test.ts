import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import { findRoute, createRoute, removeRoute, listRoutes } from '../router.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('router', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
	});

	describe('createRoute', () => {
		it('stores and returns route with id', async () => {
			const route = await createRoute(redis, {
				domain: 'example.com',
				address: 'support',
				mode: 'endpoint',
				endpointUrl: 'https://hooks.example.com/inbound',
				organizationId: 'org-1',
			});

			expect(route.id).toBe('example.com:support');
			expect(route.domain).toBe('example.com');
			expect(route.address).toBe('support');
			expect(route.mode).toBe('endpoint');
			expect(route.createdAt).toBeGreaterThan(0);
		});
	});

	describe('findRoute', () => {
		it('finds exact match', async () => {
			await createRoute(redis, {
				domain: 'example.com',
				address: 'support',
				mode: 'accept',
			});

			const route = await findRoute(redis, 'support@example.com');
			expect(route).not.toBeNull();
			expect(route!.address).toBe('support');
		});

		it('finds wildcard match (address=*)', async () => {
			await createRoute(redis, {
				domain: 'catch.com',
				address: '*',
				mode: 'hold',
			});

			const route = await findRoute(redis, 'anything@catch.com');
			expect(route).not.toBeNull();
			expect(route!.address).toBe('*');
		});

		it('exact match takes priority over wildcard', async () => {
			await createRoute(redis, {
				domain: 'priority.com',
				address: '*',
				mode: 'hold',
			});
			await createRoute(redis, {
				domain: 'priority.com',
				address: 'admin',
				mode: 'endpoint',
				endpointUrl: 'https://hooks.example.com',
			});

			const route = await findRoute(redis, 'admin@priority.com');
			expect(route).not.toBeNull();
			expect(route!.mode).toBe('endpoint');
		});

		it('returns null when no match', async () => {
			const route = await findRoute(redis, 'nobody@nowhere.com');
			expect(route).toBeNull();
		});

		it('normalizes email to lowercase', async () => {
			await createRoute(redis, {
				domain: 'example.com',
				address: 'info',
				mode: 'accept',
			});

			const route = await findRoute(redis, 'INFO@EXAMPLE.COM');
			expect(route).not.toBeNull();
			expect(route!.address).toBe('info');
		});
	});

	describe('removeRoute', () => {
		it('removes route and returns true', async () => {
			await createRoute(redis, {
				domain: 'del.com',
				address: 'test',
				mode: 'bounce',
			});

			const removed = await removeRoute(redis, 'del.com', 'test');
			expect(removed).toBe(true);

			const route = await findRoute(redis, 'test@del.com');
			expect(route).toBeNull();
		});
	});

	describe('listRoutes', () => {
		it('returns all routes', async () => {
			await createRoute(redis, { domain: 'a.com', address: '*', mode: 'hold' });
			await createRoute(redis, { domain: 'b.com', address: 'info', mode: 'accept' });

			const routes = await listRoutes(redis);
			expect(routes.length).toBe(2);
		});
	});
});
