/**
 * Inbound auth DNS-cache wiring — piece CI3.
 *
 * `createInboundAuthResolvers` wraps ONE Redis-backed `createCachedResolver`
 * (from `@owlat/mail-auth`) and hands SPF / DKIM / DMARC the resolver shape each
 * consumes. These tests pin the two load-bearing properties of that wiring:
 *
 *   (1) LOOKUP REDUCTION — a warm cache serves a name WITHOUT a base-resolver
 *       call, so a second inbound message from the same sender issues strictly
 *       fewer real DNS queries than the first (the named CI3 test gate). The
 *       reduction holds ACROSS engines: a TXT record resolved for SPF is served
 *       from cache when DMARC / DKIM look up the same name.
 *   (2) VERDICT-EQUIVALENCE at the NXDOMAIN boundary — a "no record" rejection
 *       from `dns/promises` is surfaced as an EMPTY answer, exactly as the
 *       uncached path behaved (SPF: a void lookup; DKIM: `permerror`; DMARC: no
 *       record), and a transient error is re-thrown (never cached).
 *
 * Every base resolver is driven off a static zone through the SAME
 * `makeNodeBaseResolver` the production path uses, so its NXDOMAIN→empty and
 * transient-rethrow conversions are exercised hermetically (no real DNS).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { RedisLike } from '@owlat/mail-auth';
import { checkSpf } from '@owlat/mail-auth';
import {
	createInboundAuthResolvers,
	makeNodeBaseResolver,
	type DnsResolveFn,
} from '../inboundAuthResolver.js';

interface Zone {
	TXT?: string[][];
	A?: string[];
	AAAA?: string[];
	MX?: { exchange: string; priority: number }[];
}

/** SPF include chain: resolving `u@parent.com` costs THREE TXT lookups cold. */
const ZONES: Record<string, Zone> = {
	'parent.com': { TXT: [['v=spf1 include:_spf1.parent.com include:_spf2.parent.com -all']] },
	'_spf1.parent.com': { TXT: [['v=spf1 ip4:10.0.0.0/24 -all']] },
	'_spf2.parent.com': { TXT: [['v=spf1 ip4:8.8.8.8 -all']] },
};

/**
 * A counting low-level `dns.resolve`-style function over the static zone. An
 * absent name REJECTS with ENOTFOUND exactly as `dns/promises` does, so the
 * `makeNodeBaseResolver` wrapper performs the production NXDOMAIN→empty mapping.
 */
function countingDns(): { dns: DnsResolveFn; calls: () => number } {
	let calls = 0;
	const dns: DnsResolveFn = async (name, type) => {
		calls += 1;
		const zone = ZONES[name.toLowerCase()];
		const records = zone?.[type];
		if (records === undefined) {
			const err = new Error(`ENOTFOUND ${name}`) as Error & { code: string };
			err.code = 'ENOTFOUND';
			throw err;
		}
		return { records: records as unknown[] };
	};
	return { dns, calls: () => calls };
}

function freshRedis(): RedisLike {
	return new RedisMock() as unknown as RedisLike;
}

// `ioredis-mock` instances with default options share ONE backing store, so a
// fresh `RedisMock()` does not give a fresh keyspace. Wipe it before each test
// (the repo pattern, cf. `effects.test.ts`) so cache state cannot leak across
// tests and make a lookup-count assertion order-dependent.
beforeEach(async () => {
	await (new RedisMock() as unknown as { flushall: () => Promise<unknown> }).flushall();
});

describe('createInboundAuthResolvers — DNS cache lookup reduction (CI3 gate)', () => {
	it('a warm cache serves the SPF include chain with FEWER base calls than cold', async () => {
		const redis = freshRedis();
		const counter = countingDns();
		const resolvers = createInboundAuthResolvers(redis, makeNodeBaseResolver(counter.dns));

		// Cold run: every TXT lookup in the include chain is a cache miss.
		const cold = await checkSpf('8.8.8.8', 'user@parent.com', 'helo.test', resolvers.spf);
		const coldCalls = counter.calls();
		expect(cold.result).toBe('pass');
		expect(coldCalls).toBeGreaterThanOrEqual(3); // parent + 2 includes

		// Warm run: identical query, same Redis — every name is served from cache.
		const warm = await checkSpf('8.8.8.8', 'user@parent.com', 'helo.test', resolvers.spf);
		const warmCalls = counter.calls() - coldCalls;
		expect(warm.result).toBe('pass');
		expect(warmCalls).toBeLessThan(coldCalls);
		expect(warmCalls).toBe(0);
	});

	it('caching does not change the SPF verdict (pass survives a warm run)', async () => {
		const redis = freshRedis();
		const counter = countingDns();
		const resolvers = createInboundAuthResolvers(redis, makeNodeBaseResolver(counter.dns));
		const first = await checkSpf('10.0.0.5', 'user@parent.com', 'helo.test', resolvers.spf);
		const second = await checkSpf('10.0.0.5', 'user@parent.com', 'helo.test', resolvers.spf);
		expect(first.result).toBe('pass');
		expect(second.result).toBe(first.result);
	});

	it('a TXT name resolved once is served from the shared cache across DKIM / DMARC', async () => {
		const redis = freshRedis();
		const counter = countingDns();
		const resolvers = createInboundAuthResolvers(redis, makeNodeBaseResolver(counter.dns));

		const dkimRecs = await resolvers.dkim('_spf1.parent.com');
		expect(dkimRecs).toEqual([['v=spf1 ip4:10.0.0.0/24 -all']]);
		expect(counter.calls()).toBe(1);

		// The DMARC TXT resolver hits the SAME shared cache — no new base call.
		const dmarcRecs = await resolvers.dmarcTxt('_spf1.parent.com');
		expect(dmarcRecs).toEqual([['v=spf1 ip4:10.0.0.0/24 -all']]);
		expect(counter.calls()).toBe(1);
	});
});

describe('makeNodeBaseResolver — NXDOMAIN / transient handling (verdict-equivalence)', () => {
	it('NXDOMAIN surfaces as an empty answer, then is negative-cached', async () => {
		const redis = freshRedis();
		const counter = countingDns();
		const resolvers = createInboundAuthResolvers(redis, makeNodeBaseResolver(counter.dns));

		// DKIM key lookup for an unpublished selector: an EMPTY array (never a
		// throw), exactly what the verifier needs to record `permerror`.
		const first = await resolvers.dkim('sel._domainkey.absent.test');
		expect(first).toEqual([]);
		expect(counter.calls()).toBe(1);

		// Second lookup is served from the negative cache — no base call.
		const second = await resolvers.dkim('sel._domainkey.absent.test');
		expect(second).toEqual([]);
		expect(counter.calls()).toBe(1);
	});

	it('a transient DNS error is re-thrown and never cached', async () => {
		const redis = freshRedis();
		let calls = 0;
		const dns: DnsResolveFn = async () => {
			calls += 1;
			const err = new Error('SERVFAIL') as Error & { code: string };
			err.code = 'ESERVFAIL';
			throw err;
		};
		const resolvers = createInboundAuthResolvers(redis, makeNodeBaseResolver(dns));
		await expect(resolvers.dkim('sel._domainkey.flaky.test')).rejects.toThrow();
		// A retry re-queries the base resolver (nothing was cached).
		await expect(resolvers.dkim('sel._domainkey.flaky.test')).rejects.toThrow();
		expect(calls).toBe(2);
	});
});

describe('createInboundAuthResolvers.arc — mailauth throwing-resolver shape', () => {
	it('re-throws ENOTFOUND for a "no record" answer (empty → rejection)', async () => {
		const redis = freshRedis();
		const counter = countingDns();
		const resolvers = createInboundAuthResolvers(redis, makeNodeBaseResolver(counter.dns));

		// The cached DKIM resolver surfaces "no record" as an EMPTY array; the ARC
		// adapter restores the `dns/promises` shape mailauth keys off — an
		// ENOTFOUND-coded rejection — so ARC key lookups behave identically to
		// mailauth's default (uncached) resolver, just served from the shared cache.
		await expect(resolvers.arc('sel._domainkey.absent.test', 'TXT')).rejects.toMatchObject({
			code: 'ENOTFOUND',
		});
	});

	it('returns the records verbatim for a published name, over the shared cache', async () => {
		const redis = freshRedis();
		const counter = countingDns();
		const resolvers = createInboundAuthResolvers(redis, makeNodeBaseResolver(counter.dns));

		// Warm the shared cache via the DKIM resolver, then confirm the ARC adapter
		// serves the same records from cache without a second base call.
		await resolvers.dkim('_spf1.parent.com');
		expect(counter.calls()).toBe(1);
		const arcRecs = await resolvers.arc('_spf1.parent.com', 'TXT');
		expect(arcRecs).toEqual([['v=spf1 ip4:10.0.0.0/24 -all']]);
		expect(counter.calls()).toBe(1);
	});
});
