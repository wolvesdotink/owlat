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
vi.mock('../../smtp/connectionPool.js', () => ({ pool: { invalidateBindIp: vi.fn() } }));

import {
	configuredDnsblZones,
	runDnsblCheck,
	getDnsblStatus,
	startDnsblChecker,
	SWEEP_ADDRESS_CONCURRENCY,
} from '../dnsbl.js';
import { ALERT_MESSAGE_MAX_LENGTH } from '../dnsblAlert.js';
import { dnsblQueryName } from '../dnsblLookup.js';
import { resolve4 } from 'dns/promises';
import { isMtaWebhookEvent } from '@owlat/mta-protocol/webhookEvent';
import { notifyConvex } from '../../webhooks/convexNotifier.js';
import { logger } from '../../monitoring/logger.js';
import type { MtaConfig } from '../../config.js';
import { selectIp, selectIpWithLease, setIpPoolBlock } from '../../scaling/ipPool.js';
import { createRecordingLookupDeps, dnsError, seedActivePools } from './dnsblFixtures.js';
import { createOwlatHostConfig } from '../../__tests__/helpers/fixtures.js';

const ABUSIX_API_KEY = '0123456789abcdef0123456789abcdef';
/**
 * The shipped suite must not pay real backoff sleeps: several fixtures return
 * SERVFAIL/ETIMEOUT, and with the default deps every sweep would wait a real
 * 200ms + 400ms per zone. Injected deps keep the retry path deterministic.
 */
const lookupDeps = createRecordingLookupDeps().deps;
const defaultConfig = createOwlatHostConfig();

describe('DNSBL checking', () => {
	let redis: InstanceType<typeof Redis>;
	let config: MtaConfig;

	beforeEach(async () => {
		vi.clearAllMocks();
		redis = new Redis();
		await redis.flushall();
		config = createOwlatHostConfig();
		await seedActivePools(redis, config.ipPools);
	});

	afterEach(() => vi.useRealTimers());

	describe('runDnsblCheck', () => {
		it('uses exact IPv6 nibble reversal and only queries documented IPv6-capable zones', async () => {
			expect(dnsblQueryName('2001:db8::1', 'zen.spamhaus.org')).toBe(
				'1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.zen.spamhaus.org'
			);
			expect(configuredDnsblZones(config, 'ipv6').map((zone) => zone.id)).toEqual(['spamhaus']);
			expect(
				configuredDnsblZones({ ...config, abusixDnsblApiKey: ABUSIX_API_KEY }, 'ipv6').map(
					(zone) => zone.id
				)
			).toEqual(['spamhaus', 'abusix']);
		});

		it('quarantines an IPv6 Spamhaus listing without querying IPv4-only providers', async () => {
			config = createOwlatHostConfig({
				ipPools: {
					transactional: ['203.0.113.10'],
					campaign: ['203.0.113.10', '2001:db8::1'],
				},
			});
			await seedActivePools(redis, config.ipPools);
			const queried: string[] = [];
			vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
				queried.push(hostname);
				if (hostname.startsWith('1.0.0.0.') && hostname.endsWith('.zen.spamhaus.org')) {
					return ['127.0.0.2'];
				}
				throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
			});

			await runDnsblCheck(redis, config, lookupDeps);

			expect(await redis.sismember('mta:ip-pool:active', '2001:db8::1')).toBe(0);
			const ipv6Queries = queried.filter((hostname) => hostname.startsWith('1.0.0.0.'));
			expect(ipv6Queries).toHaveLength(1);
			expect(ipv6Queries[0]).toContain('zen.spamhaus.org');
			expect(ipv6Queries[0]).not.toContain('barracudacentral');
			expect(ipv6Queries[0]).not.toContain('spamcop');
		});

		it('keeps Spamhaus as the sole ejecting feed and adds keyed Abusix as warning-only', () => {
			const defaults = configuredDnsblZones(config);
			expect(defaults.filter((zone) => zone.severity === 'critical')).toEqual([
				expect.objectContaining({ id: 'spamhaus' }),
			]);
			expect(defaults.map((zone) => zone.id)).not.toContain('abusix');
			const keyed = configuredDnsblZones({ ...config, abusixDnsblApiKey: ABUSIX_API_KEY });
			expect(keyed).toContainEqual(
				expect.objectContaining({
					id: 'abusix',
					severity: 'warning',
					zone: `${ABUSIX_API_KEY}.combined.mail.abusix.zone`,
				})
			);
		});

		it('keeps status clean when all lookups return NXDOMAIN', async () => {
			// NXDOMAIN = not listed — resolve4 throws ENOTFOUND
			vi.mocked(resolve4).mockRejectedValue(
				Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
			);

			await runDnsblCheck(redis, config, lookupDeps);

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

			await runDnsblCheck(redis, config, lookupDeps);

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

		it('never logs raw alert-delivery errors for a critical listing', async () => {
			const deliverySentinel = 'sentinel-dnsbl-alert-payload-never-log';
			vi.mocked(notifyConvex).mockRejectedValueOnce(
				Object.assign(new Error(deliverySentinel), {
					request: { body: deliverySentinel },
				})
			);
			vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
				if (hostname.includes('zen.spamhaus.org') && hostname.startsWith('1.0.0.10')) {
					return ['127.0.0.2'];
				}
				throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
			});

			await runDnsblCheck(redis, config, lookupDeps);

			const serializedLogs = JSON.stringify(vi.mocked(logger.error).mock.calls);
			expect(serializedLogs).not.toContain(deliverySentinel);
			expect(logger.error).toHaveBeenCalledWith(
				{
					operation: 'dnsbl_alert',
					category: 'delivery',
					eventType: 'ip.blocklisted',
				},
				'Failed to alert Convex about IP blocklisting'
			);
		});

		it('treats Spamhaus resolver error answers as unknown and preserves quarantine', async () => {
			await redis.sadd('mta:ip-pool:blocked', '10.0.0.1');
			await setIpPoolBlock(redis, '10.0.0.1', 'dnsbl', true);
			await redis.hset('mta:dnsbl:10.0.0.1', 'overallStatus', 'critical');
			vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
				if (hostname.includes('zen.spamhaus.org') && hostname.startsWith('1.0.0.10')) {
					return ['127.255.255.254'];
				}
				throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
			});

			await runDnsblCheck(redis, config, lookupDeps);

			expect(await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus')).toBe('unknown');
			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(0);
			expect(await redis.hget('mta:ip-pool:underlying-blocks:dnsbl', '10.0.0.1')).toBe('1');
		});

		it('clears a prior Spamhaus quarantine when Spamhaus is clean despite warning-feed failure', async () => {
			await redis.sadd('mta:ip-pool:blocked', '10.0.0.1');
			await setIpPoolBlock(redis, '10.0.0.1', 'dnsbl', true);
			await redis.hset('mta:dnsbl:10.0.0.1', 'overallStatus', 'critical', 'spamhaus', 'listed');
			vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
				if (hostname.includes('zen.spamhaus.org')) {
					throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
				}
				throw Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' });
			});

			await runDnsblCheck(redis, config, lookupDeps);

			expect(await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus')).toBe('unknown');
			expect(await redis.hget('mta:ip-pool:underlying-blocks:dnsbl', '10.0.0.1')).toBe('0');
			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(1);
		});

		it('surfaces a confirmed warning listing despite an unrelated unknown feed', async () => {
			vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
				if (hostname.includes('b.barracudacentral.org') && hostname.startsWith('1.0.0.10')) {
					return ['127.0.0.2'];
				}
				if (hostname.includes('bl.spamcop.net')) {
					throw Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' });
				}
				throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
			});

			await runDnsblCheck(redis, config, lookupDeps);

			expect(await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus')).toBe('degraded');
			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(1);
			expect(notifyConvex).toHaveBeenCalledWith(
				expect.objectContaining({
					event: 'ip.blocklisted',
					severity: 'warning',
					blocklists: ['Barracuda'],
				}),
				config,
				redis
			);
		});

		it('never emits a keyed Abusix query name or resolver message to logs', async () => {
			const apiKey = ABUSIX_API_KEY;
			config.abusixDnsblApiKey = apiKey;
			vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
				throw Object.assign(new Error(`SERVFAIL resolving ${hostname}`), { code: 'ESERVFAIL' });
			});

			await runDnsblCheck(redis, config, lookupDeps);

			const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
			expect(logged).not.toContain(apiKey);
			expect(logged).not.toContain('combined.mail.abusix.zone');
			expect(logged).toContain('abusix');
		});

		it('reports an Abusix listing as warning without removing the IP from rotation', async () => {
			config.abusixDnsblApiKey = ABUSIX_API_KEY;
			vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
				if (hostname.includes('combined.mail.abusix.zone') && hostname.startsWith('1.0.0.10')) {
					return ['127.0.0.2'];
				}
				throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
			});

			await runDnsblCheck(redis, config, lookupDeps);

			expect(await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus')).toBe('degraded');
			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(1);
			expect(notifyConvex).toHaveBeenCalledWith(
				expect.objectContaining({
					event: 'ip.blocklisted',
					severity: 'warning',
					blocklists: ['Abusix'],
				}),
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

			await runDnsblCheck(redis, config, lookupDeps);

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

			await runDnsblCheck(redis, config, lookupDeps);

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
			await runDnsblCheck(redis, config, lookupDeps);
			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(0);

			vi.mocked(resolve4).mockRejectedValue(
				Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' })
			);
			await runDnsblCheck(redis, config, lookupDeps);
			expect(await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus')).toBe('unknown');
			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(0);

			vi.mocked(resolve4).mockRejectedValue(
				Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
			);
			await runDnsblCheck(redis, config, lookupDeps);
			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(1);
		});

		it('preserves a prior critical quarantine when its critical zone is unknown but a warning zone is listed', async () => {
			vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
				if (hostname.includes('zen.spamhaus.org') && hostname.startsWith('1.0.0.10')) {
					return ['127.0.0.2'];
				}
				throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
			});
			await runDnsblCheck(redis, config, lookupDeps);

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
			await runDnsblCheck(redis, config, lookupDeps);

			expect(await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus')).toBe('degraded');
			expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(0);
			expect(await redis.hget('mta:ip-pool:underlying-blocks:dnsbl', '10.0.0.1')).toBe('1');
			expect(notifyConvex).toHaveBeenCalledWith(
				expect.objectContaining({ event: 'ip.blocklisted', severity: 'warning' }),
				config,
				redis
			);
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

			await runDnsblCheck(redis, config, lookupDeps);

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
		const redisArgumentSentinel = 'sentinel-boot-dnsbl-command-argument-never-log';
		vi.spyOn(redis, 'incr').mockRejectedValueOnce(
			Object.assign(new Error(redisArgumentSentinel), {
				command: {
					name: 'incr',
					args: ['mta:ip-pool:observation-generation:dnsbl', redisArgumentSentinel],
				},
			})
		);

		const startup = startDnsblChecker(redis, config, () => false);
		await expect(startup).rejects.toThrow('Initial DNSBL sweep failed');
		await startup.catch((error: unknown) => {
			expect(String(error)).not.toContain(redisArgumentSentinel);
			expect(error).not.toHaveProperty('command');
		});
	});

	it('never logs Redis command arguments from a failed scheduled DNSBL sweep', async () => {
		vi.useFakeTimers();
		vi.mocked(resolve4).mockRejectedValue(
			Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
		);
		const timer = await startDnsblChecker(redis, config, () => true);
		const redisArgumentSentinel = 'sentinel-scheduled-dnsbl-command-argument-never-log';
		vi.spyOn(redis, 'incr').mockRejectedValueOnce(
			Object.assign(new Error(redisArgumentSentinel), {
				command: {
					name: 'incr',
					args: ['mta:ip-pool:observation-generation:dnsbl', redisArgumentSentinel],
				},
			})
		);

		await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

		const serializedLogs = JSON.stringify(vi.mocked(logger.error).mock.calls);
		expect(serializedLogs).not.toContain(redisArgumentSentinel);
		expect(serializedLogs).not.toContain('mta:ip-pool:observation-generation:dnsbl');
		expect(logger.error).toHaveBeenCalledWith(
			{ operation: 'dnsbl_sweep', category: 'storage' },
			'DNSBL check failed'
		);
		clearInterval(timer);
	});
});

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

describe('shipped behaviour regression', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		vi.clearAllMocks();
		redis = new Redis();
		await redis.flushall();
		await seedActivePools(redis, defaultConfig.ipPools);
	});

	afterEach(() => vi.restoreAllMocks());

	it('still ejects on a Spamhaus listing and still restores on a confirmed clean sweep', async () => {
		const { deps } = createRecordingLookupDeps();
		vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
			if (hostname.includes('zen.spamhaus.org') && hostname.startsWith('1.0.0.10')) {
				return ['127.0.0.2'];
			}
			throw dnsError('ENOTFOUND');
		});

		await runDnsblCheck(redis, defaultConfig, deps);

		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus')).toBe('critical');
		expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(0);
		expect(notifyConvex).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'ip.blocklisted', severity: 'critical' }),
			defaultConfig,
			redis
		);

		vi.mocked(resolve4).mockRejectedValue(dnsError('ENOTFOUND'));
		await runDnsblCheck(redis, defaultConfig, deps);

		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus')).toBe('clean');
		expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(1);
		expect(notifyConvex).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'ip.delisted' }),
			defaultConfig,
			redis
		);
	});

	it('keeps a warning-severity listing advisory instead of ejecting', async () => {
		const { deps } = createRecordingLookupDeps();
		vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
			if (hostname.includes('b.barracudacentral.org')) return ['127.0.0.2'];
			throw dnsError('ENOTFOUND');
		});

		await runDnsblCheck(redis, defaultConfig, deps);

		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus')).toBe('degraded');
		expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(1);
	});

	it('keeps the boot sweep and the 15-minute leader-gated interval unchanged', async () => {
		vi.mocked(resolve4).mockRejectedValue(dnsError('ENOTFOUND'));
		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

		const handle = await startDnsblChecker(redis, defaultConfig, () => false);

		try {
			// The boot sweep runs on every process, leader or not.
			expect(resolve4).toHaveBeenCalled();
			expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), CHECK_INTERVAL_MS);

			const sweepsAfterBoot = vi.mocked(resolve4).mock.calls.length;
			const tick = setIntervalSpy.mock.calls[0]?.[0] as (() => void) | undefined;
			expect(tick).toBeTypeOf('function');
			tick?.();
			await Promise.resolve();
			// A non-leader tick performs no sweep.
			expect(vi.mocked(resolve4).mock.calls.length).toBe(sweepsAfterBoot);
		} finally {
			clearInterval(handle);
		}
	});
});

describe('an unmeasurable sweep is recorded as unknown, never clean', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		vi.clearAllMocks();
		redis = new Redis();
		await redis.flushall();
		await seedActivePools(redis, defaultConfig.ipPools);
	});

	it('records the sweep verdict as unknown and names the unmeasured zones', async () => {
		vi.mocked(resolve4).mockRejectedValue(dnsError('ESERVFAIL'));
		const { deps } = createRecordingLookupDeps();

		await runDnsblCheck(redis, defaultConfig, deps);

		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus')).toBe('unknown');
		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'spamhaus')).toBe('unknown');
		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'unknownOn')).toContain('Spamhaus');
		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'listedOn')).toBe('');
	});

	it('preserves an existing quarantine instead of clearing it on an unmeasurable sweep', async () => {
		await setIpPoolBlock(redis, '10.0.0.1', 'dnsbl', true);
		vi.mocked(resolve4).mockRejectedValue(dnsError('ETIMEOUT'));
		const { deps } = createRecordingLookupDeps();

		await runDnsblCheck(redis, defaultConfig, deps);

		expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(0);
		// The never-measured second address is held too: unknown fails closed.
		expect(await redis.sismember('mta:ip-pool:active', '10.0.0.2')).toBe(0);
	});
});

function allIpsListedOnSpamhaus() {
	vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
		if (hostname.includes('zen.spamhaus.org')) return ['127.0.0.2'];
		throw dnsError('ENOTFOUND');
	});
}

describe('a fully listed pool halts and alerts — it never sends anyway', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.mocked(notifyConvex).mockResolvedValue(true);
		redis = new Redis();
		await redis.flushall();
		await seedActivePools(redis, defaultConfig.ipPools);
	});

	it('names every listed address and its zones, and lets no mail leave the pool', async () => {
		allIpsListedOnSpamhaus();
		const { deps } = createRecordingLookupDeps();

		await runDnsblCheck(redis, defaultConfig, deps);

		expect(await redis.get('mta:emergency:all_ips_blocked')).toBe('1');
		const alert = vi
			.mocked(notifyConvex)
			.mock.calls.map((call) => call[0])
			.find((event) => event.event === 'all_ips_blocked');
		expect(alert).toBeDefined();
		expect(alert).toMatchObject({ severity: 'critical', blocklists: ['Spamhaus'] });
		const message = (alert as unknown as { message?: string } | undefined)?.message ?? '';
		expect(message).toContain('10.0.0.1 on Spamhaus');
		expect(message).toContain('10.0.0.2 on Spamhaus');
		expect(message).toContain('paused');

		// Halt: no eligible address, so nothing can be dispatched from the pool.
		expect(await selectIpWithLease(redis, 'campaign', defaultConfig.ipPools)).toBeNull();
		expect(await selectIp(redis, 'transactional', defaultConfig.ipPools)).toBeNull();
		expect(await selectIp(redis, 'campaign', defaultConfig.ipPools, '10.0.0.2')).toBeNull();
	});

	it('says the pool is unavailable rather than listed when the status could not be measured', async () => {
		vi.mocked(resolve4).mockRejectedValue(dnsError('ESERVFAIL'));
		const { deps } = createRecordingLookupDeps();

		await runDnsblCheck(redis, defaultConfig, deps);

		const alert = vi
			.mocked(notifyConvex)
			.mock.calls.map((call) => call[0])
			.find((event) => event.event === 'all_ips_blocked');
		expect(alert).toBeDefined();
		const message = (alert as unknown as { message?: string } | undefined)?.message ?? '';
		expect(message).toContain('unavailable');
		expect(message).toContain('an unmeasured blocklist status');
		expect(await selectIp(redis, 'campaign', defaultConfig.ipPools)).toBeNull();
	});

	it('keeps sending from the healthy remainder when only part of the pool is listed', async () => {
		vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
			if (hostname.includes('zen.spamhaus.org') && hostname.startsWith('1.0.0.10')) {
				return ['127.0.0.2'];
			}
			throw dnsError('ENOTFOUND');
		});
		const { deps } = createRecordingLookupDeps();

		await runDnsblCheck(redis, defaultConfig, deps);

		expect(await redis.get('mta:emergency:all_ips_blocked')).toBeNull();
		expect(
			vi
				.mocked(notifyConvex)
				.mock.calls.map((call) => call[0])
				.some((event) => event.event === 'all_ips_blocked')
		).toBe(false);
		expect(await selectIp(redis, 'campaign', defaultConfig.ipPools)).toBe('10.0.0.2');
	});

	it('alerts once for a standing halt, and again once the halt has lifted and returned', async () => {
		const haltAlerts = () =>
			vi
				.mocked(notifyConvex)
				.mock.calls.map((call) => call[0])
				.filter((event) => event.event === 'all_ips_blocked').length;
		const { deps } = createRecordingLookupDeps();

		allIpsListedOnSpamhaus();
		await runDnsblCheck(redis, defaultConfig, deps);
		// A halt persists for as long as delisting takes; a critical alert every
		// 15 minutes would bury the one the operator has to act on.
		await runDnsblCheck(redis, defaultConfig, deps);
		expect(haltAlerts()).toBe(1);

		// Delisted: the halt lifts, so the next one is a new event, not a repeat.
		vi.mocked(resolve4).mockRejectedValue(dnsError('ENOTFOUND'));
		await runDnsblCheck(redis, defaultConfig, deps);
		expect(await redis.get('mta:emergency:all_ips_blocked')).toBeNull();

		allIpsListedOnSpamhaus();
		await runDnsblCheck(redis, defaultConfig, deps);
		expect(haltAlerts()).toBe(2);
	});

	it('gives the day’s slot back when the alert throws, but not when the DLQ took it', async () => {
		const haltAlerts = () =>
			vi
				.mocked(notifyConvex)
				.mock.calls.map((call) => call[0])
				.filter((event) => event.event === 'all_ips_blocked').length;
		const { deps } = createRecordingLookupDeps();
		allIpsListedOnSpamhaus();

		// A THROWN alert never reached the notifier's own durability, so the halt
		// is still unannounced and the next sweep must retry it.
		vi.mocked(notifyConvex).mockImplementation(async (event) => {
			if (event.event !== 'all_ips_blocked') return true;
			throw new Error('convex unreachable');
		});
		await runDnsblCheck(redis, defaultConfig, deps);
		expect(haltAlerts()).toBe(1);

		// `false` is the other case: the notifier stored the event in the DLQ, which
		// owns its redelivery, so the slot stays consumed and the sweep stays quiet.
		vi.mocked(notifyConvex).mockResolvedValue(false);
		await runDnsblCheck(redis, defaultConfig, deps);
		expect(haltAlerts()).toBe(2);
		await runDnsblCheck(redis, defaultConfig, deps);
		expect(haltAlerts()).toBe(2);
	});
});

describe('the halt alert survives Convex ingress for a large pool', () => {
	// Convex rejects the WHOLE event when `message` exceeds 512 characters, so an
	// unbounded '<ip> on <zones>' clause per address would 400, exhaust the retry
	// budget and land the one alert the operator must see in the DLQ.
	const largePoolConfig = createOwlatHostConfig({
		ipPools: {
			transactional: Array.from({ length: 12 }, (_, index) => `10.1.0.${index + 1}`),
			campaign: Array.from({ length: 12 }, (_, index) => `10.2.0.${index + 1}`),
		},
	});
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.mocked(notifyConvex).mockResolvedValue(true);
		redis = new Redis();
		await redis.flushall();
		await seedActivePools(redis, largePoolConfig.ipPools);
	});

	it('truncates the listing detail to the ingress bound and stays a valid webhook event', async () => {
		allIpsListedOnSpamhaus();
		const { deps } = createRecordingLookupDeps();

		await runDnsblCheck(redis, largePoolConfig, deps);

		const alert = vi
			.mocked(notifyConvex)
			.mock.calls.map((call) => call[0])
			.find((event) => event.event === 'all_ips_blocked');
		expect(alert).toBeDefined();
		const message = (alert as unknown as { message?: string } | undefined)?.message ?? '';
		expect(message.length).toBeLessThanOrEqual(ALERT_MESSAGE_MAX_LENGTH);
		// Truncated, but still actionable: named addresses plus an explicit count.
		expect(message).toContain('10.1.0.1 on Spamhaus');
		expect(message).toMatch(/; and \d+ more$/);
		// Zone names are never lost — they travel structurally.
		expect(alert).toMatchObject({ blocklists: ['Spamhaus'] });
		// The bound that actually matters: Convex ingress accepts the event.
		expect(isMtaWebhookEvent(alert)).toBe(true);
	});
});

/**
 * The sweep's resolver fan-out is bounded — and so is its wall clock.
 *
 * Every configured address x every zone in one `Promise.all` is a burst of
 * hundreds of queries at a handful of public resolvers every 15 minutes, and a
 * rate-limited feed answers 127.255.255.x — which this module must read as
 * `unknown`, preserving quarantine and holding the ramp. The bound is a fixed
 * number of addresses in flight, zones parallel within an address: the boot
 * sweep is awaited before delivery workers are enabled, and the periodic sweep
 * has no in-flight guard, so a sweep whose cost is linear in pool size would
 * bring the burst back through the side door by overlapping the next tick.
 */
// More addresses than the bound, so an unbounded fan-out is visible as such.
const IPS = Array.from({ length: 9 }, (_, index) => `10.0.0.${index + 1}`);
const fanOutConfig = createOwlatHostConfig({
	ipPools: { transactional: IPS.slice(0, 5), campaign: IPS.slice(5) },
});
const ZONES = configuredDnsblZones(fanOutConfig, 'ipv4');
const ZONES_PER_IP = ZONES.length;

/** `1.0.0.10.zen.spamhaus.org` → `10.0.0.1`. IPv4 pools only in this fixture. */
function queriedIp(hostname: string): string {
	return hostname.split('.').slice(0, 4).reverse().join('.');
}

function queriedZoneIndex(hostname: string): number {
	return ZONES.findIndex((zone) => hostname.endsWith(zone.zone));
}

const VERDICTS = ['clean', 'listed', 'unknown'] as const;

/**
 * A per-address answer no other address in the fixture gives.
 *
 * The address index in base 3 picks one verdict per zone, so the nine addresses
 * hold nine distinct zone triples: an answer attributed to the wrong address
 * cannot coincide with that address's own.
 */
function verdictFor(ip: string, zoneIndex: number): (typeof VERDICTS)[number] {
	const index = IPS.indexOf(ip);
	return VERDICTS[Math.floor(index / 3 ** zoneIndex) % 3]!;
}

/** The resolver answer that produces `verdictFor`'s verdict. */
async function answerFor(hostname: string): Promise<string[]> {
	const verdict = verdictFor(queriedIp(hostname), queriedZoneIndex(hostname));
	if (verdict === 'listed') return ['127.0.0.2'];
	// The reserved rate-limit block: an answer, but not evidence either way.
	if (verdict === 'unknown') return ['127.255.255.254'];
	throw dnsError('ENOTFOUND');
}

describe('the sweep bounds its resolver fan-out', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		vi.clearAllMocks();
		redis = new Redis();
		await redis.flushall();
		await seedActivePools(redis, fanOutConfig.ipPools);
	});

	it('holds a fixed number of addresses in flight, with each address’s zones in parallel', async () => {
		const inFlight = new Set<string>();
		let peakInFlight = 0;
		let peakAddressesInFlight = 0;
		vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
			inFlight.add(hostname);
			peakInFlight = Math.max(peakInFlight, inFlight.size);
			peakAddressesInFlight = Math.max(
				peakAddressesInFlight,
				new Set([...inFlight].map(queriedIp)).size
			);
			// Yield so anything the sweep started concurrently is observed as such.
			await new Promise((resolve) => setImmediate(resolve));
			inFlight.delete(hostname);
			throw dnsError('ENOTFOUND');
		});

		await runDnsblCheck(redis, fanOutConfig, createRecordingLookupDeps().deps);

		expect(vi.mocked(resolve4)).toHaveBeenCalledTimes(IPS.length * ZONES_PER_IP);
		// The bound: the burst is a fixed width however large the pool grows.
		expect(IPS.length).toBeGreaterThan(SWEEP_ADDRESS_CONCURRENCY);
		expect(peakAddressesInFlight).toBeLessThanOrEqual(SWEEP_ADDRESS_CONCURRENCY);
		expect(peakInFlight).toBeLessThanOrEqual(SWEEP_ADDRESS_CONCURRENCY * ZONES_PER_IP);
		// …and the zones of one address really do go out together, otherwise the
		// sweep would serialize into a 15-minute crawl.
		expect(ZONES_PER_IP).toBeGreaterThan(1);
		expect(peakInFlight).toBeGreaterThanOrEqual(ZONES_PER_IP);
	});

	it('attributes each address’s zone answers to that address whatever order they arrive in', async () => {
		vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
			// Reverse-ordered latency, so the pool's workers complete out of order.
			const rank = Number(queriedIp(hostname).split('.')[3]);
			await new Promise((resolve) => setTimeout(resolve, IPS.length - rank));
			return answerFor(hostname);
		});

		await runDnsblCheck(redis, fanOutConfig, createRecordingLookupDeps().deps);

		// Every address measured exactly once — no query duplicated, none skipped.
		expect(vi.mocked(resolve4)).toHaveBeenCalledTimes(IPS.length * ZONES_PER_IP);
		const patterns = new Set<string>();
		for (const ip of IPS) {
			const expected = ZONES.map((_, zoneIndex) => verdictFor(ip, zoneIndex));
			patterns.add(expected.join('/'));
			const status = await getDnsblStatus(redis, ip);
			// Per zone, not the collapsed roll-up: a scrambled result is only
			// visible where the answers are still told apart.
			expect(ZONES.map((zone) => status?.[zone.id])).toEqual(expected);
			expect(status?.['listedOn']).toBe(
				ZONES.filter((_, index) => expected[index] === 'listed')
					.map((zone) => zone.name)
					.join(',')
			);
			expect(status?.['unknownOn']).toBe(
				ZONES.filter((_, index) => expected[index] === 'unknown')
					.map((zone) => zone.name)
					.join(',')
			);
		}
		// The pin only holds because no two addresses share an answer pattern.
		expect(patterns.size).toBe(IPS.length);
	});
});
