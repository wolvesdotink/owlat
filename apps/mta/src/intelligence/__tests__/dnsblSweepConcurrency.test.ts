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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';

vi.mock('dns/promises', () => ({ resolve4: vi.fn() }));
vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../smtp/connectionPool.js', () => ({ pool: { invalidateBindIp: vi.fn() } }));

import { resolve4 } from 'dns/promises';
import {
	configuredDnsblZones,
	getDnsblStatus,
	runDnsblCheck,
	SWEEP_ADDRESS_CONCURRENCY,
} from '../dnsbl.js';
import { initializePools } from '../../scaling/ipPool.js';
import { createDnsblTestConfig, createRecordingLookupDeps, dnsError } from './dnsblFixtures.js';

// More addresses than the bound, so an unbounded fan-out is visible as such.
const IPS = Array.from({ length: 9 }, (_, index) => `10.0.0.${index + 1}`);
const config = createDnsblTestConfig({
	ipPools: { transactional: IPS.slice(0, 5), campaign: IPS.slice(5) },
});
const ZONES_PER_IP = configuredDnsblZones(config, 'ipv4').length;

/** `1.0.0.10.zen.spamhaus.org` → `10.0.0.1`. IPv4 pools only in this fixture. */
function queriedIp(hostname: string): string {
	return hostname.split('.').slice(0, 4).reverse().join('.');
}

describe('DNSBL sweep bounds its resolver fan-out', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		vi.clearAllMocks();
		redis = new Redis();
		await redis.flushall();
		await initializePools(redis, config.ipPools);
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

		await runDnsblCheck(redis, config, createRecordingLookupDeps().deps);

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

	it('records every address exactly once regardless of the order the workers finish in', async () => {
		vi.mocked(resolve4).mockImplementation(async (hostname: string) => {
			// Reverse-ordered latency, so the pool's workers complete out of order.
			const rank = Number(queriedIp(hostname).split('.')[3]);
			await new Promise((resolve) => setTimeout(resolve, IPS.length - rank));
			throw dnsError('ENOTFOUND');
		});

		await runDnsblCheck(redis, config, createRecordingLookupDeps().deps);

		for (const ip of IPS) {
			const status = await getDnsblStatus(redis, ip);
			expect(status?.['overallStatus']).toBe('clean');
		}
	});
});
