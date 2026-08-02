/**
 * The master-key IP audit API.
 *
 * `GET /:ip` interpolates its path parameter into a Redis key, so the address
 * is validated the same way the rest of the audit stack validates one — an
 * arbitrary parameter never reaches the keyspace.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createIpAuditRoutes } from '../ipAudit.js';
import { storeIpAuditRecord, type IpAuditRecord } from '../../scaling/ipAudit.js';
import { createTestConfig } from '../../__tests__/helpers/fixtures.js';

const config = createTestConfig({
	apiKey: 'master-key',
	ipPools: { transactional: ['203.0.113.10'], campaign: ['203.0.113.10'] },
});

function record(ip: string): IpAuditRecord {
	return {
		ip,
		checkedAt: Date.now(),
		verdict: 'clean',
		confidence: 'high',
		findings: [],
		zones: [],
	};
}

describe('GET /ip-audit/:ip', () => {
	let redis: RealRedis;

	beforeEach(async () => {
		redis = new Redis() as unknown as RealRedis;
		await redis.flushall();
	});

	function get(path: string) {
		return createIpAuditRoutes(redis, config).request(path, {
			headers: { Authorization: 'Bearer master-key' },
		});
	}

	it('serves the stored audit for a canonical address', async () => {
		await storeIpAuditRecord(redis, record('203.0.113.10'));

		const res = await get('/203.0.113.10');

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ip: '203.0.113.10', verdict: 'clean' });
	});

	it.each(['not-an-ip', 'mta:dnsbl:203.0.113.10', '*', '203.0.113.999'])(
		'rejects %s with 400 instead of building a Redis key from it',
		async (ip) => {
			const res = await get(`/${encodeURIComponent(ip)}`);

			expect(res.status).toBe(400);
		}
	);

	it('still answers 404 for a valid address that has never been audited', async () => {
		const res = await get('/198.51.100.7');

		expect(res.status).toBe(404);
	});
});
