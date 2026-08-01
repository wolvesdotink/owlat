/**
 * The sweep's resolver fan-out is bounded.
 *
 * Every configured address x every zone in one `Promise.all` is a burst of
 * hundreds of queries at a handful of public resolvers every 15 minutes, and a
 * rate-limited feed answers 127.255.255.x — which this module must read as
 * `unknown`, preserving quarantine and holding the ramp. The bound is the one
 * `runIpAuditSweep` already keeps: addresses sequentially, zones in parallel
 * within an address.
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
import { configuredDnsblZones, runDnsblCheck } from '../dnsbl.js';
import { initializePools } from '../../scaling/ipPool.js';
import { createDnsblTestConfig, createRecordingLookupDeps, dnsError } from './dnsblFixtures.js';

const config = createDnsblTestConfig({
	ipPools: {
		transactional: ['10.0.0.1', '10.0.0.2', '10.0.0.3'],
		campaign: ['10.0.0.4', '10.0.0.5'],
	},
});
const IP_COUNT = 5;
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

	it('queries one address at a time, with that address’s zones in parallel', async () => {
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

		expect(vi.mocked(resolve4)).toHaveBeenCalledTimes(IP_COUNT * ZONES_PER_IP);
		// The bound: never two addresses at once, so the burst is one address wide
		// however large the pool grows.
		expect(peakAddressesInFlight).toBe(1);
		expect(peakInFlight).toBe(ZONES_PER_IP);
		// …and the zones of one address really do go out together, otherwise the
		// sweep would serialize into a 15-minute crawl.
		expect(ZONES_PER_IP).toBeGreaterThan(1);
	});
});
