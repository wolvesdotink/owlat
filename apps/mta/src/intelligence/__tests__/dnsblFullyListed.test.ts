/**
 * A fully listed pool halts and alerts — it never sends anyway.
 *
 * There is no emergency "send from a listed address" path: pool selection has
 * no eligible address, so delivery stays queued, and the operator alert names
 * the addresses and the zones that listed them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { isMtaWebhookEvent } from '@owlat/shared/mtaWebhookEvent';
import { runDnsblCheck } from '../dnsbl.js';
import { ALERT_MESSAGE_MAX_LENGTH } from '../dnsblAlert.js';
import { notifyConvex } from '../../webhooks/convexNotifier.js';
import { initializePools, selectIp, selectIpWithLease } from '../../scaling/ipPool.js';
import { createDnsblTestConfig, createRecordingLookupDeps, dnsError } from './dnsblFixtures.js';

const config = createDnsblTestConfig();

function allIpsListedOnSpamhaus() {
	vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
		if (hostname.includes('zen.spamhaus.org')) return ['127.0.0.2'];
		throw dnsError('ENOTFOUND');
	});
}

describe('DNSBL fully listed pool halts and alerts', () => {
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

	it('names every listed address and its zones, and lets no mail leave the pool', async () => {
		allIpsListedOnSpamhaus();
		const { deps } = createRecordingLookupDeps();

		await runDnsblCheck(redis, config, deps);

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
		expect(await selectIpWithLease(redis, 'campaign', config.ipPools)).toBeNull();
		expect(await selectIp(redis, 'transactional', config.ipPools)).toBeNull();
		expect(await selectIp(redis, 'campaign', config.ipPools, '10.0.0.2')).toBeNull();
	});

	it('says the pool is unavailable rather than listed when the status could not be measured', async () => {
		vi.mocked(resolve4).mockRejectedValue(dnsError('ESERVFAIL'));
		const { deps } = createRecordingLookupDeps();

		await runDnsblCheck(redis, config, deps);

		const alert = vi
			.mocked(notifyConvex)
			.mock.calls.map((call) => call[0])
			.find((event) => event.event === 'all_ips_blocked');
		expect(alert).toBeDefined();
		const message = (alert as unknown as { message?: string } | undefined)?.message ?? '';
		expect(message).toContain('unavailable');
		expect(message).toContain('an unmeasured blocklist status');
		expect(await selectIp(redis, 'campaign', config.ipPools)).toBeNull();
	});

	it('keeps sending from the healthy remainder when only part of the pool is listed', async () => {
		vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
			if (hostname.includes('zen.spamhaus.org') && hostname.startsWith('1.0.0.10')) {
				return ['127.0.0.2'];
			}
			throw dnsError('ENOTFOUND');
		});
		const { deps } = createRecordingLookupDeps();

		await runDnsblCheck(redis, config, deps);

		expect(await redis.get('mta:emergency:all_ips_blocked')).toBeNull();
		expect(
			vi
				.mocked(notifyConvex)
				.mock.calls.map((call) => call[0])
				.some((event) => event.event === 'all_ips_blocked')
		).toBe(false);
		expect(await selectIp(redis, 'campaign', config.ipPools)).toBe('10.0.0.2');
	});
});

describe('DNSBL halt alert survives Convex ingress for a large pool', () => {
	// Convex rejects the WHOLE event when `message` exceeds 512 characters, so an
	// unbounded '<ip> on <zones>' clause per address would 400, exhaust the retry
	// budget and land the one alert the operator must see in the DLQ.
	const largePoolConfig = createDnsblTestConfig({
		ipPools: {
			transactional: Array.from({ length: 12 }, (_, index) => `10.1.0.${index + 1}`),
			campaign: Array.from({ length: 12 }, (_, index) => `10.2.0.${index + 1}`),
		},
	});
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		vi.clearAllMocks();
		redis = new Redis();
		await redis.flushall();
		for (const ip of [
			...largePoolConfig.ipPools.transactional,
			...largePoolConfig.ipPools.campaign,
		]) {
			await redis.hset(`mta:fcrdns:${ip}`, 'verdict', 'pass', 'checkedAt', '1');
		}
		await initializePools(redis, largePoolConfig.ipPools);
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
