/**
 * Cached DNS resolvers for the inbound authentication path (SPF / DMARC / DKIM),
 * plus the OSTR tier lookup that rides the same cache.
 *
 * The bounce/inbound SMTP server evaluates SPF (RFC 7208), DMARC (RFC 7489) and
 * DKIM (RFC 6376) for every accepted message. Each of those checks issues DNS
 * TXT / A / AAAA / MX lookups, and a busy MX repeatedly resolves the SAME names
 * (the sender's SPF include chain, the From-domain's `_dmarc` record, a
 * signer's `<selector>._domainkey` key). This module wraps ONE Redis-backed
 * `createCachedResolver` (from `@owlat/mail-auth`) and hands each engine the
 * exact resolver shape it consumes, so a warm cache serves a name WITHOUT a
 * network round-trip.
 *
 * The cache is verdict-EQUIVALENT (sanctioned improvement I2 f): the SPF
 * §4.6.4 lookup budget counts real resolver CALLS (enforced inside `checkSpf`),
 * which a cache hit never triggers, so caching cannot let a record slip past
 * the 10-lookup cap. NXDOMAIN / NODATA is surfaced as an empty answer so the
 * engines treat it exactly as the uncached `dns/promises` path did (SPF: a void
 * lookup; DKIM: `permerror`; DMARC: no record). Any OTHER DNS error (SERVFAIL,
 * timeout) is re-thrown so it maps to `temperror` — never cached.
 */

import { resolve as dnsResolve, resolve4, resolve6 } from 'dns/promises';
import {
	createCachedResolver,
	isNoRecordDnsError,
	toSpfResolver,
	type DkimDnsResolver,
	type DnsResolver,
	type RedisLike,
	type SpfDnsResolver,
} from '@owlat/mail-auth';
import type { ResolveTxt } from '@owlat/ostr-client';
import type { ArcDnsResolver } from './inboundArc.js';

/**
 * Positive-answer TTL handed to the cache when the RR type cannot surface a
 * real per-record TTL (TXT / MX — `dns/promises` does not expose it there). The
 * cache clamps it to its 1-hour cap, the conservative bound the design allows.
 */
const POSITIVE_TTL_SECONDS = 3600;

/**
 * Cache ceiling for an OSTR tier answer, and the reason it is not the 1-hour
 * cap the auth records take.
 *
 * Spec 08 §8.1: "A client MUST honour TTLs and MUST NOT pin answers past them."
 * Node's stock resolver throws the TXT TTL away (see {@link nodeDnsResolve}), so
 * the only honest way to obey that rule without a raw-DNS library is to pin for
 * LESS than any TTL an aggregator plausibly publishes — the same §8.1 says those
 * are "around one hour for hot entries". Five minutes is comfortably under it,
 * which bounds how long a demotion to `flagged`, or the retraction of a wrongful
 * one, can take to reach this MX. The cost is one query per name per 5 minutes
 * instead of per hour, which is the cheap side of that trade.
 */
export const OSTR_TIER_MAX_TTL_SECONDS = 300;

/** Cache key prefix for OSTR tier answers — separate from the auth records so
 *  the shorter ceiling above cannot be defeated by an entry another lookup
 *  wrote at the 1-hour cap. */
const OSTR_CACHE_PREFIX = 'mailauth:dns:ostr:';

/** A low-level DNS answer: the type-specific records plus an optional TTL. */
export interface RawDnsAnswer {
	/** `TXT: string[][]`, `A/AAAA: string[]`, `MX: {exchange, priority}[]`. */
	readonly records: unknown[];
	/**
	 * The answer's TTL in seconds when the RR type surfaces one (A/AAAA), else
	 * `undefined` so the wrapper falls back to `POSITIVE_TTL_SECONDS`.
	 */
	readonly ttl?: number;
}

/** The low-level DNS query the base resolver issues (Node's `dns.resolve*`). */
export type DnsResolveFn = (
	name: string,
	type: 'A' | 'AAAA' | 'MX' | 'TXT'
) => Promise<RawDnsAnswer>;

/**
 * Production low-level resolver. A/AAAA are queried with `{ ttl: true }` so the
 * cache can honour a short SPF `a`/`mx`-target TTL instead of pinning it at the
 * 1-hour cap (the cache design says "respect the record TTL, capped at 1 hour").
 * TXT/MX cannot surface a TTL in Node, so they omit it and take the cap.
 */
const nodeDnsResolve: DnsResolveFn = async (name, type) => {
	switch (type) {
		case 'A': {
			const recs = await resolve4(name, { ttl: true });
			return { records: recs.map((r) => r.address), ttl: minTtl(recs) };
		}
		case 'AAAA': {
			const recs = await resolve6(name, { ttl: true });
			return { records: recs.map((r) => r.address), ttl: minTtl(recs) };
		}
		default:
			return { records: (await dnsResolve(name, type)) as unknown[] };
	}
};

/** Minimum TTL across an answer's records, or `undefined` for an empty set. */
function minTtl(recs: ReadonlyArray<{ ttl: number }>): number | undefined {
	return recs.length > 0 ? Math.min(...recs.map((r) => r.ttl)) : undefined;
}

/**
 * Build the base resolver over a low-level `dns.resolve`-style function
 * (injectable purely so the NXDOMAIN / transient handling is hermetically
 * testable). `dnsResolveFn(name, type)` returns the type-specific payload the
 * SPF evaluator and the DKIM key parser already expect, plus an optional TTL. A
 * "no record" rejection becomes an EMPTY answer (negative-cached by the wrapper)
 * so the engines keep their uncached semantics; any other rejection propagates
 * so it becomes `temperror` — never cached.
 */
export function makeNodeBaseResolver(dnsResolveFn: DnsResolveFn = nodeDnsResolve): DnsResolver {
	return async (name, type) => {
		try {
			const { records, ttl } = await dnsResolveFn(name, type);
			return { records, ttl: ttl ?? POSITIVE_TTL_SECONDS };
		} catch (err: unknown) {
			if (isNoRecordDnsError(err)) {
				// NXDOMAIN / NODATA → an empty answer (negative-cached by the wrapper).
				return { records: [], ttl: 0 };
			}
			// Transient failure (SERVFAIL, timeout, …): never cache, surface upstream.
			throw err;
		}
	};
}

/** The production base resolver: exactly one real `dns/promises` query per call. */
const nodeBaseResolver: DnsResolver = makeNodeBaseResolver();

/**
 * Adapt a cached TXT resolver (our "no record" = an EMPTY answer) into the
 * `dns/promises`-shaped resolver the ARC verifier expects, where "no record" is
 * an `ENOTFOUND`-coded REJECTION. Threading this adapter lets ARC's `_domainkey`
 * / ARC-seal key lookups ride the SAME shared cache instead of hitting real DNS
 * on the hot ingest path.
 */
export function toThrowingTxtResolver(dkim: (name: string) => Promise<string[][]>): ArcDnsResolver {
	return async (name, rrtype) => {
		// The ARC/DKIM key path only ever queries TXT; any other rrtype is an
		// unsupported contract, so reject explicitly rather than silently answer.
		if (rrtype !== 'TXT') {
			throw new Error(
				`unsupported rrtype '${rrtype}' for '${name}': cached ARC resolver serves TXT only`
			);
		}
		const records = await dkim(name);
		if (records.length === 0) {
			const err = new Error(`ENOTFOUND ${name}`) as Error & { code: string };
			err.code = 'ENOTFOUND';
			throw err;
		}
		return records;
	};
}

/** The resolver shapes the inbound auth engines consume, over one shared cache. */
export interface InboundAuthResolvers {
	/** SPF: `(name, type) => Promise<unknown[]>` (records only). */
	readonly spf: SpfDnsResolver;
	/** DKIM: `(name, 'TXT') => Promise<string[][]>` (key-record TXT lookup). */
	readonly dkim: DkimDnsResolver;
	/** DMARC: a TXT resolver for `dnsDmarcLookup` (`_dmarc.<domain>`). */
	readonly dmarcTxt: (name: string) => Promise<string[][]>;
	/**
	 * ARC: the DKIM TXT resolver in the `dns/promises` throwing shape the ARC
	 * verifier's seal / AMS key lookups need — same shared cache, no real DNS.
	 */
	readonly arc: ArcDnsResolver;
	/**
	 * OSTR: the `ResolveTxt` shape `@owlat/ostr-client` consumes, over its OWN
	 * Redis cache (same `base`, same connection, separate key space and a
	 * separate ceiling — {@link OSTR_TIER_MAX_TTL_SECONDS}), so a busy MX asks
	 * the aggregator's zone once per name per 5 minutes rather than once per
	 * message.
	 *
	 * `ttlSeconds` is what THIS answer is pinned for, not the record's own TTL:
	 * Node cannot surface a TXT TTL, so a miss reports the (capped) substitute
	 * the cache stored the entry under, and a HIT reports 0 — "already pinned
	 * elsewhere, do not pin again". The client's in-process cache treats 0 as
	 * "do not cache", which is what keeps the Redis entry the single expiry and
	 * stops the two caches from compounding into a pin twice as long as either.
	 *
	 * "No record" is an EMPTY answer here, which `lookupTierViaDns` reads as
	 * `not-found` — the fact "no evidence", not a lookup failure. So is a record
	 * of an unexpected shape (see {@link toTxtRecords}).
	 */
	readonly ostrTxt: ResolveTxt;
}

/**
 * Build the SPF / DKIM / DMARC / ARC resolvers over ONE shared Redis-backed
 * cache, so a name resolved for one check is served from cache for the next.
 * Pass `redis = null` to disable caching (every call hits `base`). `base` is
 * injectable purely for hermetic tests — production always uses the Node
 * `dns/promises` resolver.
 */
export function createInboundAuthResolvers(
	redis: RedisLike | null,
	base: DnsResolver = nodeBaseResolver
): InboundAuthResolvers {
	const cached = createCachedResolver(base, redis);
	const txtRecords = async (name: string): Promise<string[][]> =>
		(await cached(name, 'TXT')).records as string[][];
	const ostrCached = createCachedResolver(base, redis, {
		keyPrefix: OSTR_CACHE_PREFIX,
		maxTtlSeconds: OSTR_TIER_MAX_TTL_SECONDS,
	});
	return {
		spf: toSpfResolver(cached),
		dkim: txtRecords,
		dmarcTxt: txtRecords,
		arc: toThrowingTxtResolver(txtRecords),
		ostrTxt: async (name) => {
			const answer = await ostrCached(name, 'TXT');
			return {
				records: toTxtRecords(answer.records),
				ttlSeconds: Math.min(answer.ttl, OSTR_TIER_MAX_TTL_SECONDS),
			};
		},
	};
}

/**
 * Narrow a cached answer to TXT's `string[][]`, or to NO RECORDS at all.
 *
 * The auth resolvers above cast, which is fine for records they hand to
 * `@owlat/mail-auth`'s own parsers on a path that already treats junk as
 * `permerror`. The OSTR path is checked instead of cast because its input can
 * be a Redis entry — stale, or written by anything else holding the connection
 * — and "one record, parsed" is a load-bearing distinction there (two records
 * at a name is `not-found` by spec 08 §8.1, not "pick one"). An unexpected
 * shape becomes an empty answer, i.e. "no evidence", which is the fail-open
 * outcome every other OSTR failure lands on.
 */
function toTxtRecords(records: unknown[]): string[][] {
	const parsed: string[][] = [];
	for (const record of records) {
		if (!Array.isArray(record)) return [];
		const chunks = record.filter((chunk): chunk is string => typeof chunk === 'string');
		if (chunks.length !== record.length) return [];
		parsed.push(chunks);
	}
	return parsed;
}
