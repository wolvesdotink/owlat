import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import { selectIp, getPoolStatus, initializePools } from '../ipPool.js';
import type { IpPoolConfig } from '../../types.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const testConfig: IpPoolConfig = {
	transactional: ['10.0.0.1', '10.0.0.2', '10.0.0.3'],
	campaign: ['10.0.1.1', '10.0.1.2'],
};

describe('ipPool', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
	});

	describe('initializePools', () => {
		it('adds all IPs to active set', async () => {
			await initializePools(redis, testConfig);

			const activeIps = await redis.smembers('mta:ip-pool:active');
			expect(activeIps).toContain('10.0.0.1');
			expect(activeIps).toContain('10.0.0.2');
			expect(activeIps).toContain('10.0.0.3');
			expect(activeIps).toContain('10.0.1.1');
			expect(activeIps).toContain('10.0.1.2');
		});
	});

	describe('selectIp', () => {
		it('returns dedicated IP when active', async () => {
			await initializePools(redis, testConfig);

			const ip = await selectIp(redis, 'transactional', testConfig, '10.0.0.1');
			expect(ip).toBe('10.0.0.1');
		});

		it('falls back to pool when dedicated IP not active', async () => {
			await initializePools(redis, testConfig);
			// Remove dedicated IP from active set
			await redis.srem('mta:ip-pool:active', '10.0.0.99');

			const ip = await selectIp(redis, 'transactional', testConfig, '10.0.0.99');
			expect(ip).not.toBeNull();
			expect(testConfig.transactional).toContain(ip);
		});

		it('uses round-robin across pool IPs', async () => {
			await initializePools(redis, testConfig);

			const seen = new Set<string>();
			for (let i = 0; i < 6; i++) {
				const ip = await selectIp(redis, 'transactional', testConfig);
				if (ip) seen.add(ip);
			}
			// Should have used multiple IPs
			expect(seen.size).toBeGreaterThan(1);
		});

		it('filters out blocked IPs', async () => {
			await initializePools(redis, testConfig);
			// Remove an IP from active set to simulate blocking
			await redis.srem('mta:ip-pool:active', '10.0.0.1');

			const results: string[] = [];
			for (let i = 0; i < 10; i++) {
				const ip = await selectIp(redis, 'transactional', testConfig);
				if (ip) results.push(ip);
			}

			expect(results.every((ip) => ip !== '10.0.0.1')).toBe(true);
		});

		it('uses emergency fallback when all IPs blocked', async () => {
			// Do NOT initialize pools (no IPs in active set)
			const ip = await selectIp(redis, 'transactional', testConfig);
			// Emergency fallback returns first IP in pool
			expect(ip).toBe('10.0.0.1');
		});

		it('returns null for empty pool', async () => {
			const emptyConfig: IpPoolConfig = {
				transactional: [],
				campaign: [],
			};
			const ip = await selectIp(redis, 'transactional', emptyConfig);
			expect(ip).toBeNull();
		});
	});

	describe('getPoolStatus', () => {
		it('returns per-IP status', async () => {
			await initializePools(redis, testConfig);
			// Block one IP
			await redis.srem('mta:ip-pool:active', '10.0.0.2');

			const status = await getPoolStatus(redis, testConfig);
			const ip1 = status.find((s) => s.ip === '10.0.0.1');
			const ip2 = status.find((s) => s.ip === '10.0.0.2');

			expect(ip1?.active).toBe(true);
			expect(ip2?.active).toBe(false);
			expect(status.length).toBe(testConfig.transactional.length + testConfig.campaign.length);
		});
	});
});
