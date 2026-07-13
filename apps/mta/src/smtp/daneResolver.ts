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
import { readStreamBytes, StreamByteLimitExceeded } from '@owlat/shared';
import { parseTlsaRecord, type TlsaRecord } from '@owlat/shared/dane';
import { logger } from '../monitoring/logger.js';

const DANE_CACHE_PREFIX = 'mta:dane:';
const DANE_NEGATIVE_TTL = 300; // 5 min cache for "no usable TLSA"
const DANE_MIN_TTL = 60; // never cache a positive result for less than 1 min
const DANE_MAX_TTL = 86_400; // …nor more than 1 day
const DANE_FETCH_TIMEOUT = 10_000;
/** Reject DoH bodies larger than this before parsing (a TLSA RRset is tiny). */
const DANE_MAX_RESPONSE_BYTES = 65_536;
/** TLSA resource-record type (RFC 6698 §7.1). */
const TLSA_RRTYPE = 52;
/** DNS RCODEs we branch on (RFC 1035 §4.1.1, RFC 2136). */
const DNS_RCODE_NOERROR = 0;
const DNS_RCODE_NXDOMAIN = 3;

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

/**
 * The outcome of a TLSA lookup for one MX host.
 *
 * RFC 7672 §2.1 is precise about the three states, and conflating them is a DANE
 * downgrade (fail-open) vulnerability:
 *
 *  - `records`: the resolver returned an authenticated (AD=1) NOERROR answer with
 *    ≥1 parseable TLSA record — DANE is in force for this MX.
 *  - `no-tlsa`: authenticated denial of existence (NXDOMAIN, or a NOERROR answer
 *    with no usable TLSA), or an unauthenticated (AD absent/false) answer that D6
 *    tells us to ignore. DANE does not apply; the caller falls back to its
 *    non-DANE policy (opportunistic / MTA-STS) — the pre-DANE behaviour.
 *  - `lookup-failed`: the lookup could NOT be completed (SERVFAIL, timeout,
 *    transport error, non-2xx HTTP, oversize/garbled body). This is NOT a denial
 *    of existence — treating it as "no TLSA" would let an attacker (or an outage)
 *    who can make TLSA lookups fail silently strip DANE and deliver in cleartext.
 *    The caller must DEFER the message (temporary failure), and we never cache it.
 */
export type TlsaLookupResult =
	| { status: 'records'; records: TlsaRecord[] }
	| { status: 'no-tlsa' }
	| { status: 'lookup-failed'; reason: string };

/** A completed query outcome plus the DNS TTL to cache it for (RFC 6698 §7). */
type QueryOutcome =
	| { status: 'records'; records: TlsaRecord[]; ttl: number }
	| { status: 'no-tlsa' }
	| { status: 'lookup-failed'; reason: string };

/** The Redis-cached shape (only `records` / `no-tlsa` are ever cached). */
interface CachedTlsa {
	status: 'records' | 'no-tlsa';
	records: TlsaRecord[];
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
 * Read a DoH response body as JSON with a hard size cap (a TLSA RRset is a few
 * hundred bytes; anything large is garbage or hostile). Rejects on an oversize
 * `content-length` header before buffering, and again on the actual byte length,
 * so a lying/absent header cannot bypass the cap.
 */
async function readCappedDohJson(response: Response): Promise<DohResponse> {
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > DANE_MAX_RESPONSE_BYTES) {
		throw new Error(`DoH response too large (${declared} bytes)`);
	}
	let bytes: Uint8Array | null;
	try {
		bytes = await readStreamBytes(response.body, DANE_MAX_RESPONSE_BYTES);
	} catch (error) {
		if (error instanceof StreamByteLimitExceeded) {
			throw new Error(`DoH response exceeds ${DANE_MAX_RESPONSE_BYTES} bytes`);
		}
		throw error;
	}
	if (!bytes) throw new Error('DoH response has no body');
	return JSON.parse(new TextDecoder().decode(bytes)) as DohResponse;
}

/**
 * Query the DoH resolver for the `_25._tcp.<host>` TLSA RRset and classify the
 * outcome into the three RFC 7672 §2.1 states (see {@link TlsaLookupResult}).
 *
 * Only an authenticated denial of existence (NXDOMAIN, authenticated NODATA) or
 * an ignored-because-unauthenticated answer falls through to `no-tlsa`. A lookup
 * that could not be completed — SERVFAIL, any other non-NOERROR RCODE, a non-2xx
 * HTTP status, a timeout/transport error, or an oversize/garbled body — is
 * `lookup-failed` so the caller DEFERS rather than silently downgrading DANE.
 */
async function queryTlsa(resolverUrl: string, host: string): Promise<QueryOutcome> {
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
			return { status: 'lookup-failed', reason: `DoH HTTP ${response.status}` };
		}
		body = await readCappedDohJson(response);
	} catch (err) {
		logger.debug({ host, err }, 'DANE TLSA DoH query failed');
		return { status: 'lookup-failed', reason: 'DoH request failed' };
	}

	const rcode = body.Status ?? DNS_RCODE_NOERROR;

	// NXDOMAIN is an authenticated denial of existence → the MX publishes no TLSA;
	// fall through to the non-DANE policy (RFC 7672 §2.1).
	if (rcode === DNS_RCODE_NXDOMAIN) {
		return { status: 'no-tlsa' };
	}

	// SERVFAIL and every other non-NOERROR RCODE mean the lookup FAILED (bogus
	// DNSSEC, resolver error, refused) — NOT that the RRset is absent. Defer.
	if (rcode !== DNS_RCODE_NOERROR) {
		return { status: 'lookup-failed', reason: `DNS RCODE ${rcode}` };
	}

	// D6: without an authenticated (AD) answer the RRset is untrusted; treat it as
	// "no TLSA" (fall through) — DANE must never be driven by unauthenticated DNS.
	// This is a deliberate, card-sanctioned fall-through, not a downgrade: an
	// attacker cannot use it to STRIP a published TLSA (that path returns records).
	if (body.AD !== true) {
		logger.debug({ host }, 'DANE TLSA answer not DNSSEC-authenticated (AD absent); ignoring');
		return { status: 'no-tlsa' };
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
	// Authenticated NODATA (no usable TLSA answer) is a denial → fall through.
	if (records.length === 0) return { status: 'no-tlsa' };
	return { status: 'records', records, ttl: clampTtl(minTtl) };
}

/**
 * Resolve the TLSA state for a recipient MX host, using a Redis cache that
 * respects DNS TTLs. See {@link TlsaLookupResult} for the three outcomes.
 *
 * Never throws. A `lookup-failed` outcome is NEVER cached (so a transient outage
 * does not pin a DANE downgrade for 5 minutes) — only `records` and `no-tlsa` are.
 */
export async function lookupTlsaRecords(
	redis: Redis,
	mxHost: string,
	resolverUrl: string
): Promise<TlsaLookupResult> {
	const host = normalizeHost(mxHost);
	const cacheKey = `${DANE_CACHE_PREFIX}${host}`;

	const cached = await redis.get(cacheKey);
	if (cached) {
		try {
			const parsed = JSON.parse(cached) as CachedTlsa;
			if (parsed.status === 'no-tlsa') return { status: 'no-tlsa' };
			if (parsed.status === 'records' && Array.isArray(parsed.records)) {
				return { status: 'records', records: parsed.records };
			}
		} catch {
			// Corrupt cache entry — fall through to a fresh lookup.
		}
	}

	const outcome = await queryTlsa(resolverUrl, host);

	if (outcome.status === 'lookup-failed') {
		// Do NOT cache a failure as "no TLSA": that would strip DANE for 5 minutes
		// on a transient resolver outage. The caller defers this message instead.
		return outcome;
	}

	if (outcome.status === 'no-tlsa') {
		await redis.set(
			cacheKey,
			JSON.stringify({ status: 'no-tlsa', records: [] } satisfies CachedTlsa),
			'EX',
			DANE_NEGATIVE_TTL
		);
		return { status: 'no-tlsa' };
	}

	await redis.set(
		cacheKey,
		JSON.stringify({ status: 'records', records: outcome.records } satisfies CachedTlsa),
		'EX',
		outcome.ttl
	);
	logger.debug(
		{ host, count: outcome.records.length },
		'DANE TLSA records resolved (DNSSEC-authenticated)'
	);
	return { status: 'records', records: outcome.records };
}
