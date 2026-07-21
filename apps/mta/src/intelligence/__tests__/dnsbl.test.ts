import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';

vi.mock('dns/promises', () => ({
	resolve4: vi.fn(),
}));
vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runDnsblCheck, getDnsblStatus, startDnsblChecker } from '../dnsbl.js';
import { resolve4 } from 'dns/promises';
import { notifyConvex } from '../../webhooks/convexNotifier.js';
import type { MtaConfig } from '../../config.js';
import { initializePools, setIpPoolBlock } from '../../scaling/ipPool.js';

function createConfig(overrides: Partial<MtaConfig> = {}): MtaConfig {
	return {
		port: 3100,
		bouncePort: 25,
		redisUrl: 'redis://localhost:6379',
		apiKey: 'test-key',
		ehloHostname: 'mail.owlat.com',
		ehloHostnames: {},
		returnPathDomain: 'bounces.owlat.com',
		convexSiteUrl: 'https://test.convex.site',
		webhookSecret: 'secret',
		ipPools: { transactional: ['10.0.0.1'], campaign: ['10.0.0.2'] },
		dkimKeys: {},
		workerConcurrency: 50,
		serverId: 'test-server',
		smtpPool: {
			maxPerHost: 3,
			idleTimeoutMs: 30000,
			maxAgeMs: 300000,
			maxMessagesPerConnection: 100,
		},
		orgLimits: { defaultDailyLimit: 50000, defaultHourlyLimit: 5000 },
		submissionPort: 587,
		submissionEnabled: false,
		contentScreeningEnabled: true,
		contentMaxSizeKb: 500,
		deliveryLogMaxLen: 100000,
		deliveryLogTtlHours: 72,
		webhookDlqMaxSize: 10000,
		bounceMaxConnectionsPerIp: 10,
		bounceMaxClients: 200,
		bounceTarpitEnabled: false,
		bounceTarpitDelayMs: 5000,
		inboundSpfEnabled: false,
		rspamdRejectThreshold: 15,
		smtpPoolGlobalMaxPerHost: 10,
		...overrides,
	};
}

describe('DNSBL checking', () => {
	let redis: InstanceType<typeof Redis>;
	let config: MtaConfig;

	beforeEach(async () => {
		vi.clearAllMocks();
		redis = new Redis();
		config = createConfig();
		for (const ip of [...config.ipPools.transactional, ...config.ipPools.campaign]) {
			await redis.hset(`mta:fcrdns:${ip}`, 'verdict', 'pass', 'checkedAt', '1');
		}
		await initializePools(redis, config.ipPools);
	});

	afterEach(() => vi.useRealTimers());

	describe('runDnsblCheck', () => {
		it('keeps status clean when all lookups return NXDOMAIN', async () => {
			// NXDOMAIN = not listed — resolve4 throws ENOTFOUND
			vi.mocked(resolve4).mockRejectedValue(
				Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
			);

			await runDnsblCheck(redis, config);

			const status1 = await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus');
			const status2 = await redis.hget('mta:dnsbl:10.0.0.2', 'overallStatus');
			expect(status1).toBe('clean');
			expect(status2).toBe('clean');
		});

		it('moves IP to blocked pool on critical listing', async () => {
			// Spamhaus (critical) returns listed for 10.0.0.1, all others clean
			vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
				// Spamhaus check for 10.0.0.1
				if (hostname.includes('zen.spamhaus.org') && hostname.startsWith('1.0.0.10')) {
					return ['127.0.0.2'];
				}
				throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
			});

			await runDnsblCheck(redis, config);

			const status = await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus');
			expect(status).toBe('critical');

			// IP should be moved to blocked pool
			const isBlocked = await redis.sismember('mta:ip-pool:blocked', '10.0.0.1');
			expect(isBlocked).toBe(1);

			expect(notifyConvex).toHaveBeenCalledWith(
				expect.objectContaining({ event: 'ip.blocklisted', severity: 'critical' }),
				config,
				redis
			);
		});

		it('restores IP from blocked to active pool on delisting', async () => {
			// Simulate previously blocked IP
			await redis.sadd('mta:ip-pool:blocked', '10.0.0.1');
			await setIpPoolBlock(redis, '10.0.0.1', 'dnsbl', true);
			await redis.hset('mta:dnsbl:10.0.0.1', 'overallStatus', 'critical');
			await redis.hset('mta:dnsbl:10.0.0.2', 'overallStatus', 'clean');

			// All clean now
			vi.mocked(resolve4).mockRejectedValue(
				Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
			);

			await runDnsblCheck(redis, config);

			const status = await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus');
			expect(status).toBe('clean');

			// IP should be moved back to active
			const isActive = await redis.sismember('mta:ip-pool:active', '10.0.0.1');
			expect(isActive).toBe(1);

			expect(notifyConvex).toHaveBeenCalledWith(
				expect.objectContaining({ event: 'ip.delisted' }),
				config,
				redis
			);
		});

		it('sets emergency flag when all IPs are blocked', async () => {
			// All IPs listed on Spamhaus (critical)
			vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
				if (hostname.includes('zen.spamhaus.org')) {
					return ['127.0.0.2'];
				}
				throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
			});

			await runDnsblCheck(redis, config);

			const emergency = await redis.get('mta:emergency:all_ips_blocked');
			expect(emergency).toBe('1');

			expect(notifyConvex).toHaveBeenCalledWith(
				expect.objectContaining({ event: 'all_ips_blocked', severity: 'critical' }),
				config,
				redis
			);
		});

		it('preserves a critical quarantine through resolver failure and releases it only on confirmed clean results', async () => {
			vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
				if (hostname.includes('zen.spamhaus.org') && hostname.startsWith('1.0.0.10')) {
					return ['127.0.0.2'];
				}
				throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
			});
			await runDnsblCheck(redis, config);
			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(0);

			vi.mocked(resolve4).mockRejectedValue(
				Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' })
			);
			await runDnsblCheck(redis, config);
			expect(await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus')).toBe('unknown');
			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(0);

			vi.mocked(resolve4).mockRejectedValue(
				Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
			);
			await runDnsblCheck(redis, config);
			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(1);
		});

		it('preserves a prior critical quarantine when its critical zone is unknown but a warning zone is listed', async () => {
			vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
				if (hostname.includes('zen.spamhaus.org') && hostname.startsWith('1.0.0.10')) {
					return ['127.0.0.2'];
				}
				throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
			});
			await runDnsblCheck(redis, config);

			vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
				if (!hostname.startsWith('1.0.0.10')) {
					throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
				}
				if (hostname.includes('zen.spamhaus.org')) {
					throw Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' });
				}
				if (hostname.includes('b.barracudacentral.org')) return ['127.0.0.2'];
				throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
			});
			await runDnsblCheck(redis, config);

			expect(await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus')).toBe('unknown');
			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(0);
			expect(await redis.hget('mta:ip-pool:underlying-blocks:dnsbl', '10.0.0.1')).toBe('1');
		});
	});

	describe('getDnsblStatus', () => {
		it('returns null for unknown IP', async () => {
			const result = await getDnsblStatus(redis, '192.168.1.1');
			expect(result).toBeNull();
		});

		it('returns status hash after check', async () => {
			// Run a check so data exists
			vi.mocked(resolve4).mockRejectedValue(
				Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
			);

			await runDnsblCheck(redis, config);

			const result = await getDnsblStatus(redis, '10.0.0.1');
			expect(result).not.toBeNull();
			expect(result!.overallStatus).toBe('clean');
		});
	});

	it('always completes a boot sweep but gates later scheduled work on leadership', async () => {
		vi.useFakeTimers();
		let leader = false;
		vi.mocked(resolve4).mockRejectedValue(
			Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
		);
		const timer = await startDnsblChecker(redis, config, () => leader);
		const bootLookupCount = vi.mocked(resolve4).mock.calls.length;
		expect(bootLookupCount).toBeGreaterThan(0);

		await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
		expect(resolve4).toHaveBeenCalledTimes(bootLookupCount);

		leader = true;
		await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
		expect(vi.mocked(resolve4).mock.calls.length).toBeGreaterThan(bootLookupCount);
		clearInterval(timer);
	});

	it('rejects startup when the boot sweep cannot persist its observation', async () => {
		vi.spyOn(redis, 'incr').mockRejectedValueOnce(new Error('Redis unavailable'));

		await expect(startDnsblChecker(redis, config, () => false)).rejects.toThrow(
			'Redis unavailable'
		);
	});
});
