import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { resolveDaneMxDestinations } from '../daneMxResolver.js';

const RESOLVER = 'https://doh.example/dns-query';

function dnsResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/dns-json' },
	});
}

let redis: RealRedis;

beforeEach(async () => {
	redis = new Redis() as unknown as RealRedis;
	await redis.flushall();
});

afterEach(() => vi.restoreAllMocks());

describe('resolveDaneMxDestinations', () => {
	it('retains DNSSEC state for ordered MX and address answers', async () => {
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				dnsResponse({
					Status: 0,
					AD: true,
					Answer: [
						{ type: 15, TTL: 300, data: '20 mx2.example.' },
						{ type: 15, TTL: 300, data: '10 mx1.example.' },
					],
				})
			)
			.mockResolvedValueOnce(
				dnsResponse({ Status: 0, AD: true, Answer: [{ type: 1, data: '192.0.2.1' }] })
			)
			.mockResolvedValueOnce(dnsResponse({ Status: 0, AD: true, Answer: [] }))
			.mockResolvedValueOnce(
				dnsResponse({ Status: 0, AD: true, Answer: [{ type: 1, data: '192.0.2.2' }] })
			)
			.mockResolvedValueOnce(dnsResponse({ Status: 0, AD: true, Answer: [] }));

		const result = await resolveDaneMxDestinations(redis, 'Example.COM', RESOLVER);

		expect(result).toEqual({
			status: 'destinations',
			destinations: [
				{
					mxHostname: 'mx1.example',
					preference: 10,
					mxSecurity: 'secure',
					addressSecurity: 'secure',
					addresses: ['192.0.2.1'],
				},
				{
					mxHostname: 'mx2.example',
					preference: 20,
					mxSecurity: 'secure',
					addressSecurity: 'secure',
					addresses: ['192.0.2.2'],
				},
			],
		});
	});

	it('marks unsigned MX and address answers as insecure', async () => {
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				dnsResponse({ Status: 0, AD: false, Answer: [{ type: 15, data: '10 mx.example.' }] })
			)
			.mockResolvedValueOnce(
				dnsResponse({ Status: 0, AD: false, Answer: [{ type: 1, data: '192.0.2.1' }] })
			)
			.mockResolvedValueOnce(dnsResponse({ Status: 0, AD: false, Answer: [] }));

		const result = await resolveDaneMxDestinations(redis, 'example.com', RESOLVER);
		expect(result).toMatchObject({
			status: 'destinations',
			destinations: [{ mxSecurity: 'insecure', addressSecurity: 'insecure' }],
		});
	});

	it('distinguishes DNS lookup failure from an authenticated absence', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(dnsResponse({ Status: 2, AD: false }));
		await expect(resolveDaneMxDestinations(redis, 'example.com', RESOLVER)).resolves.toEqual({
			status: 'lookup-failed',
			reason: 'MX DNS RCODE 2',
		});

		vi.mocked(fetch).mockResolvedValueOnce(dnsResponse({ Status: 3, AD: true }));
		await expect(resolveDaneMxDestinations(redis, 'missing.example', RESOLVER)).resolves.toEqual({
			status: 'not-found',
		});
	});

	it('recognizes authenticated Null MX without resolving addresses', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				dnsResponse({ Status: 0, AD: true, Answer: [{ type: 15, data: '0 .' }] })
			);

		await expect(resolveDaneMxDestinations(redis, 'null.example', RESOLVER)).resolves.toEqual({
			status: 'null-mx',
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
