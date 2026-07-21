import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import { selectIp, getPoolStatus, initializePools, setIpPoolBlock } from '../ipPool.js';
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

		it('fails closed instead of changing identity when a dedicated IP is unavailable', async () => {
			await initializePools(redis, testConfig);
			await setIpPoolBlock(redis, '10.0.0.1', 'fcrdns', true);

			const ip = await selectIp(redis, 'transactional', testConfig, '10.0.0.1');
			expect(ip).toBeNull();
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

		it('fails closed when all IPs are blocked', async () => {
			// Do NOT initialize pools (no IPs in active set)
			const ip = await selectIp(redis, 'transactional', testConfig);
			expect(ip).toBeNull();
		});

		it('never selects a quarantined dedicated IP when no pool fallback is eligible', async () => {
			await initializePools(redis, testConfig);
			for (const ip of testConfig.transactional) {
				await setIpPoolBlock(redis, ip, 'fcrdns', true);
			}
			expect(await selectIp(redis, 'transactional', testConfig, '10.0.0.1')).toBeNull();
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

	describe('composed eligibility blocks', () => {
		it('does not reactivate an IP until every subsystem clears its reason', async () => {
			await initializePools(redis, testConfig);
			await Promise.all([
				setIpPoolBlock(redis, '10.0.0.1', 'dnsbl', true),
				setIpPoolBlock(redis, '10.0.0.1', 'fcrdns', true),
			]);

			await setIpPoolBlock(redis, '10.0.0.1', 'dnsbl', false);
			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(0);
			expect((await getPoolStatus(redis, testConfig))[0]?.blockReasons).toEqual(['fcrdns']);

			await setIpPoolBlock(redis, '10.0.0.1', 'fcrdns', false);
			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(1);
		});
	});
});
