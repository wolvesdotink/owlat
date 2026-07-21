import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { resolveMxDestination, type MxDnsLookup } from '../mxResolver.js';
import { logger } from '../../monitoring/logger.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function dnsError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`DNS ${code}`), { code });
}

describe('resolveMxDestination', () => {
	let redis: RealRedis;

	beforeEach(async () => {
		vi.clearAllMocks();
		redis = new Redis() as unknown as RealRedis;
		await redis.flushall();
	});

	it.each(['SERVFAIL', 'ETIMEOUT'])('treats %s as a temporary, uncached failure', async (code) => {
		const lookup = vi
			.fn<MxDnsLookup>()
			.mockRejectedValueOnce(dnsError(code))
			.mockResolvedValueOnce([{ exchange: 'mx.recovered.example', priority: 10 }]);

		expect(await resolveMxDestination(redis, 'example.com', lookup)).toMatchObject({
			status: 'temporary-failure',
		});
		expect(await resolveMxDestination(redis, 'example.com', lookup)).toMatchObject({
			status: 'deliverable',
			hosts: [{ exchange: 'mx.recovered.example', priority: 10 }],
		});
		expect(lookup).toHaveBeenCalledTimes(2);
	});

	it.each(['ENOTFOUND', 'NXDOMAIN'])('treats %s as a hard domain failure', async (code) => {
		const lookup = vi.fn<MxDnsLookup>().mockRejectedValue(dnsError(code));
		expect(await resolveMxDestination(redis, 'missing.example', lookup)).toMatchObject({
			status: 'domain-not-found',
		});
	});

	it.each(['ENODATA', 'NODATA'])('uses implicit MX for %s', async (code) => {
		const lookup = vi.fn<MxDnsLookup>().mockRejectedValue(dnsError(code));
		expect(await resolveMxDestination(redis, 'MAIL.Example.', lookup)).toEqual({
			status: 'deliverable',
			source: 'implicit',
			hosts: [{ exchange: 'mail.example', priority: 0 }],
		});
	});

	it('uses implicit MX for an authoritative empty MX answer', async () => {
		const lookup = vi.fn<MxDnsLookup>().mockResolvedValue([]);
		expect(await resolveMxDestination(redis, 'example.com', lookup)).toEqual({
			status: 'deliverable',
			source: 'implicit',
			hosts: [{ exchange: 'example.com', priority: 0 }],
		});
	});

	it('recognizes Null MX and rejects a mixed Null MX RRset', async () => {
		const nullLookup = vi.fn<MxDnsLookup>().mockResolvedValue([{ exchange: '.', priority: 0 }]);
		expect(await resolveMxDestination(redis, 'null.example', nullLookup)).toEqual({
			status: 'null-mx',
		});

		const mixedLookup = vi.fn<MxDnsLookup>().mockResolvedValue([
			{ exchange: '.', priority: 0 },
			{ exchange: 'mx.example', priority: 10 },
		]);
		expect(await resolveMxDestination(redis, 'mixed.example', mixedLookup)).toMatchObject({
			status: 'temporary-failure',
		});
	});

	it('normalizes internationalized recipient domains before lookup and caching', async () => {
		const lookup = vi.fn<MxDnsLookup>().mockResolvedValue([]);
		await resolveMxDestination(redis, 'BÜCHER.example.', lookup);

		expect(lookup).toHaveBeenCalledWith('xn--bcher-kva.example');
		expect(await redis.get('mta:mx-cache:v2:xn--bcher-kva.example')).not.toBeNull();
	});

	it('selects the best 50 MX records after validation and preference ordering', async () => {
		const lookup = vi.fn<MxDnsLookup>().mockResolvedValue(
			Array.from({ length: 75 }, (_, index) => ({
				exchange: `mx-${index}.example`,
				priority: 74 - index,
			}))
		);

		const result = await resolveMxDestination(redis, 'many.example', lookup);
		expect(result.status).toBe('deliverable');
		if (result.status === 'deliverable') {
			expect(result.hosts).toHaveLength(50);
			expect(result.hosts[0]).toEqual({ exchange: 'mx-74.example', priority: 0 });
			expect(result.hosts.at(-1)).toEqual({ exchange: 'mx-25.example', priority: 49 });
		}
	});

	it.each([
		'not-json',
		JSON.stringify({ status: 'deliverable', source: 'mx', hosts: [] }),
		JSON.stringify({
			status: 'deliverable',
			source: 'mx',
			hosts: [{ exchange: 'mx.example', priority: -1 }],
		}),
	])('ignores a malformed cache entry: %s', async (cached) => {
		await redis.set('mta:mx-cache:v2:example.com', cached);
		const lookup = vi
			.fn<MxDnsLookup>()
			.mockResolvedValue([{ exchange: 'mx.valid.example', priority: 0 }]);

		expect(await resolveMxDestination(redis, 'example.com', lookup)).toMatchObject({
			status: 'deliverable',
			hosts: [{ exchange: 'mx.valid.example', priority: 0 }],
		});
		expect(logger.warn).toHaveBeenCalledWith(
			{ domain: 'example.com' },
			'Ignoring malformed MX cache entry'
		);
	});
});
