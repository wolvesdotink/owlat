/**
 * Cached DNS resolvers for the inbound authentication path (SPF / DMARC / DKIM).
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

import { resolve as dnsResolve } from 'dns/promises';
import {
	createCachedResolver,
	toSpfResolver,
	type DkimDnsResolver,
	type DnsResolver,
	type RedisLike,
	type SpfDnsResolver,
} from '@owlat/mail-auth';

/**
 * DNS error codes that mean "no such record". `dns/promises` REJECTS with these
 * rather than resolving an empty array, so the base resolver converts them into
 * an empty answer: this is what lets the cache negative-cache NXDOMAIN/NODATA
 * (an empty answer is negative-cached for 5 min by `createCachedResolver`) while
 * the engines keep their existing void-lookup / permerror / no-record semantics.
 */
const EMPTY_ANSWER_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NOTFOUND', 'NXDOMAIN']);

/** Positive-answer TTL floor handed to the cache; clamped to its 1-hour cap. */
const POSITIVE_TTL_SECONDS = 3600;

/** The low-level DNS query the base resolver issues (Node's `dns.resolve`). */
export type DnsResolveFn = (name: string, type: 'A' | 'AAAA' | 'MX' | 'TXT') => Promise<unknown[]>;

/**
 * Build the base resolver over a low-level `dns.resolve`-style function
 * (injectable purely so the NXDOMAIN / transient handling is hermetically
 * testable). `dnsResolveFn(name, type)` returns the type-specific payload
 * (`TXT: string[][]`, `A/AAAA: string[]`, `MX: {exchange, priority}[]`) the SPF
 * evaluator and the DKIM key parser already expect. A "no record" rejection
 * becomes an EMPTY answer (negative-cached by the wrapper) so the engines keep
 * their uncached semantics; any other rejection propagates so it becomes
 * `temperror` — never cached.
 *
 * TTL: `dns/promises` does not surface a per-record TTL for TXT/MX, so positive
 * answers are stored with a TTL that `createCachedResolver` clamps to its 1-hour
 * cap — the conservative bound the cache design specifies.
 */
export function makeNodeBaseResolver(
	dnsResolveFn: DnsResolveFn = (name, type) =>
		dnsResolve(name, type) as unknown as Promise<unknown[]>
): DnsResolver {
	return async (name, type) => {
		try {
			const records = await dnsResolveFn(name, type);
			return { records, ttl: POSITIVE_TTL_SECONDS };
		} catch (err: unknown) {
			const code = (err as { code?: string }).code;
			if (code !== undefined && EMPTY_ANSWER_CODES.has(code)) {
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

/** The three resolver shapes the inbound auth engines consume. */
export interface InboundAuthResolvers {
	/** SPF: `(name, type) => Promise<unknown[]>` (records only). */
	readonly spf: SpfDnsResolver;
	/** DKIM: `(name, 'TXT') => Promise<string[][]>` (key-record TXT lookup). */
	readonly dkim: DkimDnsResolver;
	/** DMARC: a TXT resolver for `dnsDmarcLookup` (`_dmarc.<domain>`). */
	readonly dmarcTxt: (name: string) => Promise<string[][]>;
}

/**
 * Build the SPF / DKIM / DMARC resolvers over ONE shared Redis-backed cache, so
 * a name resolved for one check is served from cache for the next. Pass
 * `redis = null` to disable caching (every call hits `base`). `base` is
 * injectable purely for hermetic tests — production always uses the Node
 * `dns/promises` resolver.
 */
export function createInboundAuthResolvers(
	redis: RedisLike | null,
	base: DnsResolver = nodeBaseResolver
): InboundAuthResolvers {
	const cached = createCachedResolver(base, redis);
	return {
		spf: toSpfResolver(cached),
		dkim: async (name) => (await cached(name, 'TXT')).records as string[][],
		dmarcTxt: async (name) => (await cached(name, 'TXT')).records as string[][],
	};
}
