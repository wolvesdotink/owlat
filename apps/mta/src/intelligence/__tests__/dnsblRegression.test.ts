/**
 * Regression pins for the shipped DNSBL behaviour this fix must not disturb:
 * the listed/clean verdicts, the Spamhaus-only ejection policy, the delisting
 * notification, and the watcher's boot sweep + 15-minute leader-gated schedule.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';

vi.mock('dns/promises', () => ({ resolve4: vi.fn() }));
vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../smtp/connectionPool.js', () => ({
	pool: { invalidateBindIp: vi.fn() },
}));

import { resolve4 } from 'dns/promises';
import { runDnsblCheck, startDnsblChecker } from '../dnsbl.js';
import { notifyConvex } from '../../webhooks/convexNotifier.js';
import { initializePools } from '../../scaling/ipPool.js';
import { createDnsblTestConfig, createRecordingLookupDeps, dnsError } from './dnsblFixtures.js';

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const config = createDnsblTestConfig();

describe('DNSBL shipped behaviour regression', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		vi.clearAllMocks();
		redis = new Redis();
		await redis.flushall();
		for (const ip of [...config.ipPools.transactional, ...config.ipPools.campaign]) {
			await redis.hset(`mta:fcrdns:${ip}`, 'verdict', 'pass', 'checkedAt', '1');
		}
		await initializePools(redis, config.ipPools);
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

		await runDnsblCheck(redis, config, deps);

		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus')).toBe('critical');
		expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(0);
		expect(notifyConvex).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'ip.blocklisted', severity: 'critical' }),
			config,
			redis
		);

		vi.mocked(resolve4).mockRejectedValue(dnsError('ENOTFOUND'));
		await runDnsblCheck(redis, config, deps);

		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus')).toBe('clean');
		expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(1);
		expect(notifyConvex).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'ip.delisted' }),
			config,
			redis
		);
	});

	it('keeps a warning-severity listing advisory instead of ejecting', async () => {
		const { deps } = createRecordingLookupDeps();
		vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
			if (hostname.includes('b.barracudacentral.org')) return ['127.0.0.2'];
			throw dnsError('ENOTFOUND');
		});

		await runDnsblCheck(redis, config, deps);

		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus')).toBe('degraded');
		expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(1);
	});

	it('keeps the boot sweep and the 15-minute leader-gated interval unchanged', async () => {
		vi.mocked(resolve4).mockRejectedValue(dnsError('ENOTFOUND'));
		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

		const handle = await startDnsblChecker(redis, config, () => false);

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
