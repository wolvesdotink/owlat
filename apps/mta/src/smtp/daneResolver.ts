/**
 * DANE / TLSA resolver for outbound delivery (RFC 7672).
 *
 * Looks up the `_25._tcp.<mx-host>` TLSA RRset for a recipient MX via a DoH
 * (DNS-over-HTTPS, RFC 8484 JSON form) resolver and returns the parsed,
 * DNSSEC-authenticated records the sender matches the MX certificate against.
 *
 * DNSSEC IS THE TRUST ANCHOR (locked decision D6). DANE is only safe when the
 * TLSA lookup is DNSSEC-validated: an on-path attacker who can forge DNS can
 * otherwise strip the TLSA RRset and defeat DANE. We therefore trust the
 * configured resolver's AD (Authenticated Data) bit and REQUIRE it — an answer
 * with AD absent/false is treated as "no TLSA" (fall back to the non-DANE
 * policy). Operators are advised to run a local validating resolver; a public
 * DoH endpoint that sets AD is acceptable but trusts that endpoint's validation.
 *
 * Results are cached in Redis respecting the answer's DNS TTL (clamped to a sane
 * floor/ceiling), with a short negative cache for "no usable TLSA".
 */

import type Redis from 'ioredis';
import { parseTlsaRecord, type TlsaRecord } from '@owlat/shared';
import { logger } from '../monitoring/logger.js';

const DANE_CACHE_PREFIX = 'mta:dane:';
const DANE_NEGATIVE_TTL = 300; // 5 min cache for "no usable TLSA"
const DANE_MIN_TTL = 60; // never cache a positive result for less than 1 min
const DANE_MAX_TTL = 86_400; // …nor more than 1 day
const DANE_FETCH_TIMEOUT = 10_000;
/** TLSA resource-record type (RFC 6698 §7.1). */
const TLSA_RRTYPE = 52;
/** DNS RCODE NOERROR — anything else means no usable answer. */
const DNS_RCODE_NOERROR = 0;

/** One answer entry in an RFC 8484 JSON (`application/dns-json`) response. */
interface DohAnswer {
	name?: string;
	type?: number;
	TTL?: number;
	data?: string;
}

/** The RFC 8484 JSON response shape we consume. */
interface DohResponse {
	Status?: number;
	/** DNSSEC Authenticated Data bit — true only when the resolver validated. */
	AD?: boolean;
	Answer?: DohAnswer[];
}

/** The cached TLSA records for one MX host. */
interface CachedTlsa {
	records: TlsaRecord[];
}

/** A lookup result plus the DNS TTL to cache it for (RFC 6698 §7). */
interface TlsaLookup extends CachedTlsa {
	/** Smallest TTL across the TLSA answers (seconds), for cache expiry. */
	ttl: number;
}

/** Normalise an MX hostname for the TLSA query name and cache key. */
function normalizeHost(mxHost: string): string {
	return mxHost.trim().toLowerCase().replace(/\.$/, '');
}

/** Clamp an answer TTL into the cache's [floor, ceiling]. */
function clampTtl(ttl: number | undefined): number {
	if (ttl === undefined || !Number.isFinite(ttl) || ttl <= 0) return DANE_MIN_TTL;
	return Math.min(Math.max(Math.floor(ttl), DANE_MIN_TTL), DANE_MAX_TTL);
}

/**
 * Query the DoH resolver for the `_25._tcp.<host>` TLSA RRset. Returns the
 * DNSSEC-authenticated records, or `null` on any transport
 * error (caller falls back to the non-DANE policy).
 */
async function queryTlsa(resolverUrl: string, host: string): Promise<TlsaLookup | null> {
	const name = `_25._tcp.${host}`;
	const url = new URL(resolverUrl);
	url.searchParams.set('name', name);
	url.searchParams.set('type', String(TLSA_RRTYPE));
	// RFC 8484 §4.2.1: ask the resolver to perform DNSSEC validation.
	url.searchParams.set('do', '1');

	let body: DohResponse;
	try {
		const response = await fetch(url, {
			headers: { Accept: 'application/dns-json' },
			signal: AbortSignal.timeout(DANE_FETCH_TIMEOUT),
		});
		if (!response.ok) {
			logger.debug({ host, status: response.status }, 'DANE TLSA DoH query non-2xx');
			return null;
		}
		body = (await response.json()) as DohResponse;
	} catch (err) {
		logger.debug({ host, err }, 'DANE TLSA DoH query failed');
		return null;
	}

	// NXDOMAIN / SERVFAIL / any non-NOERROR → no usable TLSA (fall through).
	if ((body.Status ?? DNS_RCODE_NOERROR) !== DNS_RCODE_NOERROR) {
		return { records: [], ttl: DANE_NEGATIVE_TTL };
	}

	// D6: without an authenticated (AD) answer, the RRset is untrusted and is
	// treated as "no TLSA" — DANE must never be driven by unauthenticated DNS.
	if (body.AD !== true) {
		logger.debug({ host }, 'DANE TLSA answer not DNSSEC-authenticated (AD absent); ignoring');
		return { records: [], ttl: DANE_NEGATIVE_TTL };
	}

	const records: TlsaRecord[] = [];
	let minTtl = DANE_MAX_TTL;
	for (const answer of body.Answer ?? []) {
		if (answer.type !== TLSA_RRTYPE || typeof answer.data !== 'string') continue;
		const parsed = parseTlsaRecord(answer.data);
		if (parsed) {
			records.push(parsed);
			if (typeof answer.TTL === 'number') minTtl = Math.min(minTtl, answer.TTL);
		}
	}
	return {
		records,
		ttl: records.length > 0 ? clampTtl(minTtl) : DANE_NEGATIVE_TTL,
	};
}

/**
 * Resolve the DNSSEC-authenticated TLSA records for a recipient MX host, using a
 * Redis cache that respects DNS TTLs. Returns an empty array when there is no
 * usable/authenticated TLSA RRset (the caller then applies its non-DANE policy).
 *
 * Never throws: any resolver/transport error resolves to `[]`.
 */
export async function lookupTlsaRecords(
	redis: Redis,
	mxHost: string,
	resolverUrl: string
): Promise<TlsaRecord[]> {
	const host = normalizeHost(mxHost);
	const cacheKey = `${DANE_CACHE_PREFIX}${host}`;

	const cached = await redis.get(cacheKey);
	if (cached) {
		try {
			const parsed = JSON.parse(cached) as CachedTlsa;
			if (Array.isArray(parsed.records)) return parsed.records;
		} catch {
			// Corrupt cache entry — fall through to a fresh lookup.
		}
	}

	const result = await queryTlsa(resolverUrl, host);
	if (!result) {
		// Transport error: short negative cache so we do not hammer the resolver.
		await redis.set(
			cacheKey,
			JSON.stringify({ records: [] } satisfies CachedTlsa),
			'EX',
			DANE_NEGATIVE_TTL
		);
		return [];
	}

	const entry: CachedTlsa = { records: result.records };
	await redis.set(cacheKey, JSON.stringify(entry), 'EX', result.ttl);

	if (result.records.length > 0) {
		logger.debug(
			{ host, count: result.records.length },
			'DANE TLSA records resolved (DNSSEC-authenticated)'
		);
	}
	return result.records;
}
