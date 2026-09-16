/**
 * The on-demand outbound-identity re-check.
 *
 * `/health` answers from the verdict the last sweep STORED, which is why an
 * operator who corrects a PTR record stays blocked for up to an hour: the
 * installer re-reads the same stale `fail`, and `docker compose up -d` leaves an
 * unchanged container running so no boot sweep re-observes it either. The
 * behaviour this file pins is that a re-check sees the CURRENT DNS.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Live DNS, swapped between calls the way a provider console swaps a PTR. */
const zone = {
	ptr: ['static.10.113.0.203.clients.example-host.de'],
	forward: { 'static.10.113.0.203.clients.example-host.de': ['203.0.113.10'] } as Record<
		string,
		string[]
	>,
};

vi.mock('dns/promises', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	reverse: async () => zone.ptr,
	resolve4: async (host: string) => zone.forward[host] ?? [],
	resolve6: async () => [],
}));

import { createOutboundIdentityRoutes } from '../outboundIdentity.js';
import { initializePools } from '../../scaling/ipPool.js';
import { createTestConfig } from '../../__tests__/helpers/fixtures.js';

const config = createTestConfig({
	apiKey: 'master-key',
	ehloHostname: 'mail.example.com',
	ipPools: { transactional: ['203.0.113.10'], campaign: ['203.0.113.10'] },
});

describe('POST /identity/recheck', () => {
	let redis: RealRedis;

	beforeEach(async () => {
		redis = new Redis() as unknown as RealRedis;
		await redis.flushall();
		await initializePools(redis, config.ipPools);
		zone.ptr = ['static.10.113.0.203.clients.example-host.de'];
		zone.forward = { 'static.10.113.0.203.clients.example-host.de': ['203.0.113.10'] };
	});

	function recheck() {
		return createOutboundIdentityRoutes(redis, config).request('/recheck', {
			method: 'POST',
			headers: { Authorization: 'Bearer master-key' },
		});
	}

	async function verdictOf(res: Response): Promise<string | undefined> {
		const body = (await res.json()) as { ips: Array<{ ip: string; fcrdns: { verdict: string } }> };
		return body.ips.find((entry) => entry.ip === '203.0.113.10')?.fcrdns?.verdict;
	}

	it('reports the live verdict, and a corrected PTR replaces the stored failure', async () => {
		expect(await verdictOf(await recheck())).toBe('fail');

		// The operator sets reverse DNS to the EHLO name and publishes the forward
		// record. Nothing restarts; only DNS changed.
		zone.ptr = ['mail.example.com'];
		zone.forward = { 'mail.example.com': ['203.0.113.10'] };

		expect(await verdictOf(await recheck())).toBe('pass');
	});

	it('rejects a request without the master key', async () => {
		const res = await createOutboundIdentityRoutes(redis, config).request('/recheck', {
			method: 'POST',
		});
		expect(res.status).toBe(401);
	});

	it('serves the stored verdict without re-observing on GET', async () => {
		await recheck();
		zone.ptr = ['mail.example.com'];
		zone.forward = { 'mail.example.com': ['203.0.113.10'] };

		const res = await createOutboundIdentityRoutes(redis, config).request('/', {
			headers: { Authorization: 'Bearer master-key' },
		});
		expect(await verdictOf(res)).toBe('fail');
	});
});
