import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import {
	selectIp,
	selectIpWithLease,
	isIpEligibilityLeaseValid,
	applyIpPoolObservation,
	nextIpPoolObservationGeneration,
	getPoolStatus,
	initializePools,
	setIpPoolBlock,
} from '../ipPool.js';
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
		for (const ip of [...testConfig.transactional, ...testConfig.campaign]) {
			await redis.hset(`mta:fcrdns:${ip}`, 'verdict', 'pass', 'checkedAt', '1');
		}
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

		it('keeps a newly added, never-verified IP inactive during a rolling deployment', async () => {
			await redis.del('mta:fcrdns:10.0.0.3');
			await initializePools(redis, testConfig);

			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(1);
			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.3')).toBe(0);
			expect(await redis.get('mta:emergency:all_ips_blocked')).toBeNull();
		});

		it('removes retired membership so an old dedicated route cannot select it', async () => {
			await initializePools(redis, testConfig);
			const rotated: IpPoolConfig = {
				transactional: ['10.0.0.2', '10.0.0.3'],
				campaign: testConfig.campaign,
			};
			await initializePools(redis, rotated);

			expect(await redis.sismember('mta:ip-pool:configured', '10.0.0.1')).toBe(0);
			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(0);
			expect(await selectIp(redis, 'transactional', rotated, '10.0.0.1')).toBeNull();
		});

		it('clears retired readiness observations so re-adding an IP requires fresh verification', async () => {
			await initializePools(redis, testConfig);
			await redis.hset('mta:dnsbl:10.0.0.1', 'overallStatus', 'critical');
			await redis.hset('mta:ip-pool:applied-observations:dnsbl', '10.0.0.1', '7');
			await redis.hset('mta:ip-pool:underlying-blocks:dnsbl', '10.0.0.1', '1');
			await initializePools(redis, {
				transactional: testConfig.transactional.slice(1),
				campaign: testConfig.campaign,
			});

			expect(await redis.exists('mta:fcrdns:10.0.0.1')).toBe(0);
			expect(await redis.exists('mta:dnsbl:10.0.0.1')).toBe(0);
			expect(await redis.hget('mta:ip-pool:applied-observations:dnsbl', '10.0.0.1')).toBeNull();

			await initializePools(redis, testConfig);
			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(0);
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

		it('invalidates a selected lease when the IP is quarantined before SMTP acquisition', async () => {
			await initializePools(redis, testConfig);
			const lease = await selectIpWithLease(redis, 'transactional', testConfig, '10.0.0.1');
			expect(lease).not.toBeNull();
			expect(await isIpEligibilityLeaseValid(redis, lease!)).toBe(true);

			await setIpPoolBlock(redis, '10.0.0.1', 'dnsbl', true);
			expect(await isIpEligibilityLeaseValid(redis, lease!)).toBe(false);
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
		it('rejects a stale observation without overwriting newer state or eligibility', async () => {
			const oneIp: IpPoolConfig = { transactional: ['10.0.0.1'], campaign: [] };
			await initializePools(redis, oneIp);
			const olderGeneration = await nextIpPoolObservationGeneration(redis, '10.0.0.1', 'fcrdns');
			const newerGeneration = await nextIpPoolObservationGeneration(redis, '10.0.0.1', 'fcrdns');

			const newer = await applyIpPoolObservation(redis, {
				ip: '10.0.0.1',
				reason: 'fcrdns',
				generation: newerGeneration,
				decision: 'block',
				stateKey: 'mta:fcrdns:10.0.0.1',
				stateFields: { verdict: 'fail', reason: 'no-ptr' },
			});
			const stale = await applyIpPoolObservation(redis, {
				ip: '10.0.0.1',
				reason: 'fcrdns',
				generation: olderGeneration,
				decision: 'clear',
				stateKey: 'mta:fcrdns:10.0.0.1',
				stateFields: { verdict: 'pass', reason: '' },
			});

			expect(newer).toMatchObject({ applied: true, active: false, becameBlocked: true });
			expect(stale).toMatchObject({ applied: false, active: false });
			expect(await redis.hget('mta:fcrdns:10.0.0.1', 'verdict')).toBe('fail');
			expect(await redis.get('mta:emergency:all_ips_blocked')).toBe('1');
		});

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

		it('updates the configured-only emergency aggregate on block and recovery', async () => {
			const oneIp: IpPoolConfig = { transactional: ['10.0.0.1'], campaign: [] };
			await initializePools(redis, oneIp);
			await setIpPoolBlock(redis, '10.0.0.1', 'fcrdns', true);
			expect(await redis.get('mta:emergency:all_ips_blocked')).toBe('1');

			await setIpPoolBlock(redis, '10.0.0.1', 'fcrdns', false);
			expect(await redis.get('mta:emergency:all_ips_blocked')).toBeNull();
		});
	});
});
