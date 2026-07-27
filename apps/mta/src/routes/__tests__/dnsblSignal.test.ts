/**
 * The three-state reaches the routing signal honestly.
 *
 * listed / clean / unknown must survive the roll-up into the snapshot the MTA
 * publishes on /ip-reputation: a fully ejected pool is critical, a partly
 * ejected pool is reported (not collapsed into "clean"), and an unmeasurable
 * lookup is reported as unknown rather than as health.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';

vi.mock('../../monitoring/collector.js', () => ({
	getIpMetrics: vi.fn().mockResolvedValue({}),
	getIspMetrics: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../intelligence/warming.js', () => ({
	getWarmingState: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../intelligence/circuitBreaker.js', () => ({
	getState: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../scaling/fcrdns.js', () => ({
	getFcrdnsReadiness: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../scaling/ipv6SpfReadiness.js', () => ({
	getIpv6SpfReadiness: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../scaling/sourceAddressReadiness.js', () => ({
	getSourceAddressReadiness: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// ipReputation reaches intelligence/dnsbl, which pulls in the real SMTP
// connection pool (and its Prometheus registry) purely for `invalidateBindIp`.
// The sibling DNSBL suites stub it the same way.
vi.mock('../../smtp/connectionPool.js', () => ({
	pool: { invalidateBindIp: vi.fn() },
}));

import { createIpReputationRoutes } from '../ipReputation.js';
import { initializePools, setIpPoolBlock } from '../../scaling/ipPool.js';
import { createDnsblTestConfig } from '../../intelligence/__tests__/dnsblFixtures.js';
import {
	hasCriticalBlocklistSignal,
	isAdvisoryDeliverabilitySignalSource,
	type DeliverabilitySignal,
} from '@owlat/shared/deliverabilityRouting';

const config = createDnsblTestConfig();

async function readSignals(redis: InstanceType<typeof Redis>): Promise<DeliverabilitySignal[]> {
	const response = await createIpReputationRoutes(redis, config).request('/', {
		headers: { Authorization: `Bearer ${config.apiKey}` },
	});
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		routing: { generatedAt: number; signals: DeliverabilitySignal[] };
	};
	return body.routing.signals;
}

describe('DNSBL routing signal honesty', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		vi.clearAllMocks();
		redis = new Redis();
		await redis.flushall();
		for (const ip of [...config.ipPools.transactional, ...config.ipPools.campaign]) {
			await redis.hset(`mta:fcrdns:${ip}`, 'verdict', 'pass', 'checkedAt', '1');
			// A realistic completed sweep: every zone answered, nothing unmeasured.
			await redis.hset(
				`mta:dnsbl:${ip}`,
				'spamhaus',
				'clean',
				'barracuda',
				'clean',
				'spamcop',
				'clean',
				'listedOn',
				'',
				'unknownOn',
				'',
				'overallStatus',
				'clean'
			);
		}
		await initializePools(redis, config.ipPools);
	});

	it('emits no DNSBL signal for a measured, clean pool', async () => {
		const signals = await readSignals(redis);

		expect(signals.filter((signal) => signal.source.startsWith('dnsbl'))).toEqual([]);
		expect(hasCriticalBlocklistSignal(signals)).toBe(false);
	});

	it('reports an unmeasurable address as unknown, never as clean', async () => {
		await redis.hset(
			'mta:dnsbl:10.0.0.1',
			'spamcop',
			'unknown',
			'unknownOn',
			'SpamCop',
			'overallStatus',
			'unknown'
		);

		const signals = await readSignals(redis);

		const unknown = signals.find((signal) => signal.source === 'dnsbl_unknown');
		expect(unknown).toMatchObject({ provider: 'all', severity: 'warning' });
		expect(isAdvisoryDeliverabilitySignalSource('dnsbl_unknown')).toBe(true);
		// Unknown is measurement confidence, not a blocklist hard stop.
		expect(hasCriticalBlocklistSignal(signals)).toBe(false);
	});

	it('reports a never-swept address as unknown', async () => {
		await redis.del('mta:dnsbl:10.0.0.2');

		const signals = await readSignals(redis);

		expect(signals.some((signal) => signal.source === 'dnsbl_unknown')).toBe(true);
	});

	it('reports an uncompleted lookup that a warning-severity listing would otherwise mask', async () => {
		// overallStatus is a PRIORITY roll-up (critical > degraded > unknown), so a
		// Barracuda listing on one zone collapses a SpamCop timeout on another into
		// 'degraded'. The signal must still say "we could not measure this address".
		await redis.hset(
			'mta:dnsbl:10.0.0.1',
			'barracuda',
			'listed',
			'listedOn',
			'Barracuda',
			'spamcop',
			'unknown',
			'unknownOn',
			'SpamCop',
			'overallStatus',
			'degraded'
		);

		const signals = await readSignals(redis);

		expect(signals.find((signal) => signal.source === 'dnsbl_unknown')).toMatchObject({
			provider: 'all',
			severity: 'warning',
		});
		// A warning-severity listing does not eject, so no blocklist hard stop.
		expect(hasCriticalBlocklistSignal(signals)).toBe(false);
	});

	it('falls back to the per-zone statuses for rows written before unknownOn existed', async () => {
		await redis.hdel('mta:dnsbl:10.0.0.1', 'unknownOn', 'listedOn');
		await redis.hset(
			'mta:dnsbl:10.0.0.1',
			'barracuda',
			'listed',
			'spamcop',
			'unknown',
			'overallStatus',
			'degraded'
		);

		const signals = await readSignals(redis);

		expect(signals.some((signal) => signal.source === 'dnsbl_unknown')).toBe(true);
	});

	it('reports a partly ejected pool and drives the critical blocklist hard stop', async () => {
		await setIpPoolBlock(redis, '10.0.0.1', 'dnsbl', true);
		await redis.hset('mta:dnsbl:10.0.0.1', 'overallStatus', 'critical');

		const signals = await readSignals(redis);

		expect(signals.find((signal) => signal.source === 'dnsbl_partial')).toMatchObject({
			provider: 'all',
			severity: 'critical',
		});
		// The shipped whole-pool signal stays reserved for a fully ejected pool.
		expect(signals.some((signal) => signal.source === 'dnsbl_listed')).toBe(false);
		expect(hasCriticalBlocklistSignal(signals)).toBe(true);
	});

	it('keeps the shipped whole-pool critical signal when every address is ejected', async () => {
		for (const ip of ['10.0.0.1', '10.0.0.2']) {
			await setIpPoolBlock(redis, ip, 'dnsbl', true);
			await redis.hset(`mta:dnsbl:${ip}`, 'overallStatus', 'critical');
		}

		const signals = await readSignals(redis);

		expect(signals.find((signal) => signal.source === 'dnsbl_listed')).toMatchObject({
			provider: 'all',
			severity: 'critical',
		});
		expect(signals.some((signal) => signal.source === 'dnsbl_partial')).toBe(false);
		expect(hasCriticalBlocklistSignal(signals)).toBe(true);
	});
});
