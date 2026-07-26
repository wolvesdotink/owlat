/**
 * Unknown is never clean — at every layer.
 *
 * A lookup that could not be completed (timeout, SERVFAIL, REFUSED, resolver
 * policy refusal, query-rate limiting) is an absence of measurement. Counting
 * it as evidence of health is the fail-open defect this suite pins shut.
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

import { resolve4 } from 'dns/promises';
import { checkDnsbl, runDnsblCheck } from '../dnsbl.js';
import { initializePools, setIpPoolBlock } from '../../scaling/ipPool.js';
import { createDnsblTestConfig, createRecordingLookupDeps, dnsError } from './dnsblFixtures.js';

const config = createDnsblTestConfig();

describe('DNSBL unknown is never laundered into clean', () => {
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

	afterEach(() => vi.useRealTimers());

	it.each([
		['SERVFAIL', 'ESERVFAIL'],
		['REFUSED', 'EREFUSED'],
		['connection refused', 'ECONNREFUSED'],
		['resolver unreachable', 'EAI_AGAIN'],
		['aborted', 'ECANCELLED'],
		['malformed response', 'EBADRESP'],
		['an unrecognised failure', 'ESOMETHINGELSE'],
	])('reports %s as unknown, never clean', async (_label, code) => {
		vi.mocked(resolve4).mockRejectedValue(dnsError(code));
		const { deps } = createRecordingLookupDeps();

		expect(await checkDnsbl('10.0.0.1', 'spamhaus', 'zen.spamhaus.org', deps)).toBe('unknown');
	});

	it.each([
		['policy refusal', '127.255.255.252'],
		['open resolver rejection', '127.255.255.254'],
		['query rate limit', '127.255.255.255'],
	])('reports the reserved return code for %s as unknown at every zone', async (_label, answer) => {
		vi.mocked(resolve4).mockResolvedValue([answer]);
		const { deps } = createRecordingLookupDeps();

		for (const [listId, zone] of [
			['spamhaus', 'zen.spamhaus.org'],
			['barracuda', 'b.barracudacentral.org'],
			['spamcop', 'bl.spamcop.net'],
		] as const) {
			expect(await checkDnsbl('10.0.0.1', listId, zone, deps)).toBe('unknown');
		}
	});

	it('reports a lookup that never answers as unknown once the per-attempt timeout fires', async () => {
		vi.useFakeTimers();
		vi.mocked(resolve4).mockImplementation(() => new Promise<string[]>(() => {}));
		const { deps } = createRecordingLookupDeps();

		const pending = checkDnsbl('10.0.0.1', 'spamhaus', 'zen.spamhaus.org', deps);
		await vi.advanceTimersByTimeAsync(5_000 * 3 + 50);

		expect(await pending).toBe('unknown');
	});

	it('keeps NXDOMAIN and NODATA as the only clean verdicts', async () => {
		const { deps } = createRecordingLookupDeps();
		for (const code of ['ENOTFOUND', 'ENODATA']) {
			vi.mocked(resolve4).mockRejectedValue(dnsError(code));
			expect(await checkDnsbl('10.0.0.1', 'spamhaus', 'zen.spamhaus.org', deps)).toBe('clean');
		}
	});

	it('records the sweep verdict as unknown and names the unmeasured zones', async () => {
		vi.mocked(resolve4).mockRejectedValue(dnsError('ESERVFAIL'));
		const { deps } = createRecordingLookupDeps();

		await runDnsblCheck(redis, config, deps);

		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'overallStatus')).toBe('unknown');
		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'spamhaus')).toBe('unknown');
		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'unknownOn')).toContain('Spamhaus');
		expect(await redis.hget('mta:dnsbl:10.0.0.1', 'listedOn')).toBe('');
	});

	it('preserves an existing quarantine instead of clearing it on an unmeasurable sweep', async () => {
		await setIpPoolBlock(redis, '10.0.0.1', 'dnsbl', true);
		vi.mocked(resolve4).mockRejectedValue(dnsError('ETIMEOUT'));
		const { deps } = createRecordingLookupDeps();

		await runDnsblCheck(redis, config, deps);

		expect(await redis.sismember('mta:ip-pool:active', '10.0.0.1')).toBe(0);
		// The never-measured second address is held too: unknown fails closed.
		expect(await redis.sismember('mta:ip-pool:active', '10.0.0.2')).toBe(0);
	});
});
