/**
 * DANE TLSA resolver tests (RFC 7672 / RFC 8484 JSON, locked decision D6).
 *
 * The DNSSEC AD (Authenticated Data) bit is the trust anchor: an authenticated
 * (AD=1) answer yields usable TLSA records; an unauthenticated (AD absent/0)
 * answer is treated as "no TLSA" and MUST be ignored. Crucially, RFC 7672 §2.1
 * distinguishes an authenticated DENIAL of existence (NXDOMAIN → fall through to
 * the non-DANE path) from a lookup FAILURE (SERVFAIL / timeout / transport error
 * / non-2xx → the lookup could not be completed, so the caller must DEFER, never
 * silently downgrade DANE). A failure is never cached. Records are cached.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { lookupTlsaRecords } from '../daneResolver.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const RESOLVER = 'https://doh.example/dns-query';
const MX = 'mx.recipient.test';

function dohResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/dns-json' },
	}) as unknown as Response;
}

/** A secure (AD=1) NOERROR answer carrying one DANE-EE SPKI SHA-256 record. */
function secureTlsaAnswer(data = '3 1 1 aabbcc'): unknown {
	return {
		Status: 0,
		AD: true,
		Answer: [{ name: `_25._tcp.${MX}`, type: 52, TTL: 3600, data }],
	};
}

let redis: RealRedis;

beforeEach(async () => {
	redis = new Redis() as unknown as RealRedis;
	// ioredis-mock shares one backing store across `new Redis()` instances, so a
	// prior test's cache entry would otherwise leak into this one. Start clean.
	await redis.flushall();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('lookupTlsaRecords — AD-bit enforcement (D6)', () => {
	it('AD=1 secure answer yields the parsed TLSA records', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(dohResponse(secureTlsaAnswer()));

		const result = await lookupTlsaRecords(redis, MX, RESOLVER);

		expect(result).toEqual({
			status: 'records',
			records: [{ usage: 3, selector: 1, matchingType: 1, data: 'aabbcc' }],
		});
	});

	it('AD absent => records ignored (treated as no TLSA, fall through)', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			dohResponse({
				Status: 0,
				// No AD field at all.
				Answer: [{ name: `_25._tcp.${MX}`, type: 52, TTL: 3600, data: '3 1 1 aabbcc' }],
			})
		);

		expect(await lookupTlsaRecords(redis, MX, RESOLVER)).toEqual({ status: 'no-tlsa' });
	});

	it('AD=false => records ignored even when a TLSA answer is present', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			dohResponse({
				Status: 0,
				AD: false,
				Answer: [{ name: `_25._tcp.${MX}`, type: 52, TTL: 3600, data: '3 1 1 aabbcc' }],
			})
		);

		expect(await lookupTlsaRecords(redis, MX, RESOLVER)).toEqual({ status: 'no-tlsa' });
	});
});

describe('lookupTlsaRecords — denial of existence falls through', () => {
	it('NXDOMAIN (Status 3) => no-tlsa (authenticated denial, fall through)', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(dohResponse({ Status: 3, AD: true }));
		expect(await lookupTlsaRecords(redis, MX, RESOLVER)).toEqual({ status: 'no-tlsa' });
	});

	it('authenticated NODATA (NOERROR, AD=1, no TLSA answer) => no-tlsa', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			dohResponse({ Status: 0, AD: true, Answer: [] })
		);
		expect(await lookupTlsaRecords(redis, MX, RESOLVER)).toEqual({ status: 'no-tlsa' });
	});

	it('ignores non-TLSA (type != 52) and unparseable answers', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			dohResponse({
				Status: 0,
				AD: true,
				Answer: [
					{ name: MX, type: 5, TTL: 60, data: 'cname.target.' }, // CNAME
					{ name: `_25._tcp.${MX}`, type: 52, TTL: 60, data: 'garbage' }, // bad TLSA
					{ name: `_25._tcp.${MX}`, type: 52, TTL: 60, data: '2 0 1 ddeeff' }, // good
				],
			})
		);

		expect(await lookupTlsaRecords(redis, MX, RESOLVER)).toEqual({
			status: 'records',
			records: [{ usage: 2, selector: 0, matchingType: 1, data: 'ddeeff' }],
		});
	});
});

describe('lookupTlsaRecords — a lookup FAILURE defers (never downgrades)', () => {
	it('SERVFAIL (Status 2) => lookup-failed (defer, not fall-through)', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(dohResponse({ Status: 2, AD: false }));
		const result = await lookupTlsaRecords(redis, MX, RESOLVER);
		expect(result.status).toBe('lookup-failed');
	});

	it('a transport error resolves to lookup-failed (never throws)', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
		const result = await lookupTlsaRecords(redis, MX, RESOLVER);
		expect(result.status).toBe('lookup-failed');
	});

	it('non-2xx DoH response => lookup-failed', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('nope', { status: 502 }) as unknown as Response
		);
		const result = await lookupTlsaRecords(redis, MX, RESOLVER);
		expect(result.status).toBe('lookup-failed');
	});

	it('a lookup failure is NEVER cached (a later success is honoured)', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(dohResponse({ Status: 2, AD: false })) // SERVFAIL
			.mockResolvedValueOnce(dohResponse(secureTlsaAnswer())); // recovers

		const first = await lookupTlsaRecords(redis, MX, RESOLVER);
		const second = await lookupTlsaRecords(redis, MX, RESOLVER);

		expect(first.status).toBe('lookup-failed');
		expect(second).toEqual({
			status: 'records',
			records: [{ usage: 3, selector: 1, matchingType: 1, data: 'aabbcc' }],
		});
		// A failure must not have been negative-cached, so the second call re-fetched.
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});
});

describe('lookupTlsaRecords — caching', () => {
	it('a second lookup is served from cache (single fetch)', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(dohResponse(secureTlsaAnswer()));

		const first = await lookupTlsaRecords(redis, MX, RESOLVER);
		const second = await lookupTlsaRecords(redis, MX, RESOLVER);

		expect(first).toEqual(second);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('a no-tlsa denial is negative-cached (single fetch)', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(dohResponse({ Status: 3 }));

		const first = await lookupTlsaRecords(redis, MX, RESOLVER);
		const second = await lookupTlsaRecords(redis, MX, RESOLVER);

		expect(first).toEqual({ status: 'no-tlsa' });
		expect(second).toEqual({ status: 'no-tlsa' });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('normalises the host (trailing dot / case) for the query and cache key', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(dohResponse(secureTlsaAnswer()));

		await lookupTlsaRecords(redis, 'MX.Recipient.Test.', RESOLVER);
		const requestUrl = String(fetchSpy.mock.calls[0]?.[0]);
		expect(requestUrl).toContain('name=_25._tcp.mx.recipient.test');
		expect(requestUrl).toContain('type=52');
	});
});
