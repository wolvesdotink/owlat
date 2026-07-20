/**
 * Cached DNS resolver — the NEW Own-the-Inbound A1 test surface.
 *
 * Asserts the TTL contract of `createCachedResolver`:
 *   - the record TTL is honored on a positive answer,
 *   - that TTL is capped at 1 hour (`MAX_DNS_TTL_SECONDS`),
 *   - empty (NXDOMAIN/NODATA) answers are negative-cached for 5 minutes,
 *   - a warm cache serves without invoking the base resolver (so the SPF budget,
 *     enforced per mechanism in `spf.ts`, counts resolver calls, not cache hits),
 *   - a Redis-down client fails OPEN — resolution still succeeds, uncached,
 * and the VERDICT-EQUIVALENCE property: `checkSpf` produces identical verdicts
 * whether it runs against a live (uncached) resolver or a cache-wrapped one,
 * across the SPF fixture set.
 */

import { describe, it, expect, afterEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import {
	createCachedResolver,
	toSpfResolver,
	MAX_DNS_TTL_SECONDS,
	NEGATIVE_TTL_SECONDS,
	type DnsResolver,
	type DnsRecordType,
	type RedisLike,
} from '../dns.js';
import { checkSpf, type SpfVerdict } from '../spf.js';

// ─── Fixtures ───────────────────────────────────────────────────────

interface Zone {
	TXT?: string[][];
	A?: string[];
	AAAA?: string[];
	MX?: { exchange: string; priority: number }[];
}

/** A hermetic base resolver over a static zone map; every answer carries `ttl`. */
function makeBase(zones: Record<string, Zone>, ttl = 300): DnsResolver {
	return async (name: string, type: DnsRecordType) => {
		const zone = zones[name.toLowerCase()];
		const records = (zone?.[type] ?? []) as unknown[];
		return { records, ttl };
	};
}

/** The SPF fixture set exercised for verdict-equivalence. */
const SPF_ZONES: Record<string, Zone> = {
	'good.com': { TXT: [['v=spf1 ip4:1.2.3.4 -all']] },
	'parent.com': { TXT: [['v=spf1 include:_spf.parent.com -all']] },
	'_spf.parent.com': { TXT: [['v=spf1 ip4:8.8.8.8 -all']] },
	'a.com': { TXT: [['v=spf1 a -all']], A: ['3.3.3.3'] },
	'mx.com': { TXT: [['v=spf1 mx -all']], MX: [{ exchange: 'mail.mx.com', priority: 10 }] },
	'mail.mx.com': { A: ['4.4.4.4'] },
	'ms.com': { TXT: [['v=spf1 ip6:2001:db8::/32 -all']] },
	// bare.com: intentionally absent → no SPF record → `none`.
};

interface SpfCase {
	readonly name: string;
	readonly ip: string;
	readonly from: string;
	readonly expected: SpfVerdict;
}

const SPF_CASES: readonly SpfCase[] = [
	{ name: 'ip4 pass', ip: '1.2.3.4', from: 'u@good.com', expected: 'pass' },
	{ name: 'ip4 no-match fail', ip: '9.9.9.9', from: 'u@good.com', expected: 'fail' },
	{ name: 'include pass', ip: '8.8.8.8', from: 'u@parent.com', expected: 'pass' },
	{ name: 'a mechanism pass', ip: '3.3.3.3', from: 'u@a.com', expected: 'pass' },
	{ name: 'mx mechanism pass', ip: '4.4.4.4', from: 'u@mx.com', expected: 'pass' },
	{ name: 'ip6 cidr pass', ip: '2001:db8:1::1', from: 'u@ms.com', expected: 'pass' },
	{ name: 'no SPF record none', ip: '5.5.5.5', from: 'u@bare.com', expected: 'none' },
];

// ─── Isolation ──────────────────────────────────────────────────────
// `ioredis-mock` backs every `new RedisMock()` with ONE process-global store,
// so keys written by one test (e.g. `mailauth:dns:TXT:good.com`) would leak into
// the next as a stale cache hit. Flush that shared store after each test so every
// case starts cold.
afterEach(async () => {
	await new RedisMock().flushall();
});

// ─── TTL contract ───────────────────────────────────────────────────

describe('createCachedResolver — TTL contract', () => {
	it('honors the record TTL on a positive answer', async () => {
		const redis = new RedisMock();
		const cached = createCachedResolver(makeBase(SPF_ZONES, 120), redis as unknown as RedisLike);
		await cached('good.com', 'TXT');
		const ttl = await redis.ttl('mailauth:dns:TXT:good.com');
		expect(ttl).toBeLessThanOrEqual(120);
		expect(ttl).toBeGreaterThanOrEqual(118);
	});

	it('caps a huge record TTL at 1 hour', async () => {
		const redis = new RedisMock();
		const cached = createCachedResolver(
			makeBase(SPF_ZONES, 999_999),
			redis as unknown as RedisLike
		);
		await cached('good.com', 'TXT');
		const ttl = await redis.ttl('mailauth:dns:TXT:good.com');
		expect(ttl).toBeLessThanOrEqual(MAX_DNS_TTL_SECONDS);
		expect(ttl).toBeGreaterThanOrEqual(MAX_DNS_TTL_SECONDS - 2);
	});

	it('negative-caches an empty (NXDOMAIN/NODATA) answer for 5 minutes', async () => {
		const redis = new RedisMock();
		const cached = createCachedResolver(makeBase(SPF_ZONES, 120), redis as unknown as RedisLike);
		// bare.com has no records → empty answer → negative cache.
		const answer = await cached('bare.com', 'TXT');
		expect(answer.records).toEqual([]);
		const ttl = await redis.ttl('mailauth:dns:TXT:bare.com');
		expect(ttl).toBeLessThanOrEqual(NEGATIVE_TTL_SECONDS);
		expect(ttl).toBeGreaterThanOrEqual(NEGATIVE_TTL_SECONDS - 2);
	});

	it('serves a warm cache without invoking the base resolver', async () => {
		const redis = new RedisMock();
		let baseCalls = 0;
		const base: DnsResolver = async (name, type) => {
			baseCalls += 1;
			return makeBase(SPF_ZONES, 300)(name, type);
		};
		const cached = createCachedResolver(base, redis as unknown as RedisLike);

		const first = await cached('good.com', 'TXT');
		const second = await cached('good.com', 'TXT');

		// Second call is a cache hit — base is NOT re-invoked.
		expect(baseCalls).toBe(1);
		expect(second.records).toEqual(first.records);
	});
});

// ─── Fail-open ──────────────────────────────────────────────────────

describe('createCachedResolver — Redis-down passthrough (fail-open)', () => {
	it('resolves uncached, calling the base each time, when Redis errors', async () => {
		let baseCalls = 0;
		const base: DnsResolver = async (name, type) => {
			baseCalls += 1;
			return makeBase(SPF_ZONES, 300)(name, type);
		};
		const downRedis: RedisLike = {
			get: async () => {
				throw new Error('ECONNREFUSED');
			},
			set: async () => {
				throw new Error('ECONNREFUSED');
			},
		};
		const cached = createCachedResolver(base, downRedis);

		const a = await cached('good.com', 'TXT');
		const b = await cached('good.com', 'TXT');

		expect(a.records).toEqual([['v=spf1 ip4:1.2.3.4 -all']]);
		expect(b.records).toEqual(a.records);
		// No cache means every call reaches the base resolver.
		expect(baseCalls).toBe(2);
	});

	it('null redis disables caching entirely', async () => {
		let baseCalls = 0;
		const base: DnsResolver = async (name, type) => {
			baseCalls += 1;
			return makeBase(SPF_ZONES, 300)(name, type);
		};
		const cached = createCachedResolver(base, null);
		await cached('good.com', 'TXT');
		await cached('good.com', 'TXT');
		expect(baseCalls).toBe(2);
	});
});

// ─── Verdict equivalence: cached vs live ────────────────────────────

describe('checkSpf verdict equivalence — cached resolver vs live', () => {
	it('produces the same verdict for every SPF fixture, cached or live', async () => {
		const live = toSpfResolver(makeBase(SPF_ZONES, 300));

		for (const c of SPF_CASES) {
			const redis = new RedisMock();
			const cached = toSpfResolver(
				createCachedResolver(makeBase(SPF_ZONES, 300), redis as unknown as RedisLike)
			);

			const liveResult = await checkSpf(c.ip, c.from, 'ehlo.host', live);
			const cachedResult = await checkSpf(c.ip, c.from, 'ehlo.host', cached);

			expect(liveResult.result, `${c.name} (live)`).toBe(c.expected);
			expect(cachedResult.result, `${c.name} (cached)`).toBe(c.expected);
			expect(cachedResult.result, `${c.name} cached==live`).toBe(liveResult.result);
		}
	});

	it('yields the identical verdict on a warm cache (second evaluation)', async () => {
		const redis = new RedisMock();
		let baseCalls = 0;
		const base: DnsResolver = async (name, type) => {
			baseCalls += 1;
			return makeBase(SPF_ZONES, 300)(name, type);
		};
		const cached = toSpfResolver(createCachedResolver(base, redis as unknown as RedisLike));

		const cold = await checkSpf('8.8.8.8', 'u@parent.com', 'ehlo.host', cached);
		const coldCalls = baseCalls;
		const warm = await checkSpf('8.8.8.8', 'u@parent.com', 'ehlo.host', cached);

		expect(cold.result).toBe('pass');
		expect(warm.result).toBe(cold.result);
		// The warm evaluation is served entirely from cache — no new base calls,
		// yet the RFC 7208 mechanism budget still governed the (identical) verdict.
		expect(baseCalls).toBe(coldCalls);
	});
});
