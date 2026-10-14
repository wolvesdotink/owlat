/**
 * MTA-STS (RFC 8461) Policy Fetching & Enforcement
 *
 * Protects against STARTTLS stripping attacks by fetching and caching
 * MTA-STS policies from recipient domains. When a domain publishes an
 * "enforce" policy, TLS is required and MX hostnames are validated.
 *
 * Flow:
 * 1. Check DNS TXT record at _mta-sts.{domain} for policy version
 * 2. If version changed (or uncached), fetch https://mta-sts.{domain}/.well-known/mta-sts.txt
 * 3. Cache parsed policy in Redis; it applies until cachedAt + max_age
 * 4. Return TLS requirements for SMTP sender to apply
 */

import { resolveTxt } from 'dns/promises';
import type Redis from 'ioredis';
import { logger } from '../monitoring/logger.js';
import { fetchStsPolicyText } from './mtaStsFetch.js';

const STS_CACHE_PREFIX = 'mta:sts:';
const STS_DNS_NEGATIVE_CACHE_TTL = 3600; // 1h cache for domains without MTA-STS
// Refetch throttle: after a fetch, an expired policy (max_age below this) is
// not fetched again for this long, so a short max_age can't turn every send
// into a 10s HTTPS round trip. Expiry itself is checked separately: a policy
// is never applied past cachedAt + max_age.
const STS_REFETCH_THROTTLE_SECONDS = 300;
// RFC 8461 §3.2: max_age has a maximum of 31557600 seconds (one year).
const STS_MAX_AGE_CEILING = 31_557_600;
// How many mx patterns the "policy cached" log line carries; the full list is cached.
const STS_LOGGED_MX_ENTRIES = 10;
const STS_MODES: readonly StsPolicyMode[] = ['enforce', 'testing', 'none'];

/**
 * Thrown for a fetched body that is not a usable STSv1 policy. It goes down
 * the fetch-failure path, so it never replaces a cached policy.
 */
export class InvalidStsPolicyError extends Error {}

export type StsPolicyMode = 'enforce' | 'testing' | 'none';

export interface StsPolicy {
	/** Policy mode: enforce (require TLS), testing (report-only), none (no policy) */
	mode: StsPolicyMode;
	/** Allowed MX hostname patterns (e.g., ["*.google.com", "mail.google.com"]) */
	mx: string[];
	/** Lifetime in seconds from cachedAt (policy max_age, capped at one year) */
	maxAge: number;
	/** Policy version ID from DNS TXT record */
	version: string;
	/** When this policy was cached */
	cachedAt: number;
}

/**
 * Get MTA-STS TLS options for a recipient domain
 *
 * Returns the TLS floor the sender resolves into its @owlat/smtp-client acquire:
 * - requireTLS: true when policy mode is "enforce"
 * - rejectUnauthorized: true when policy mode is "enforce"
 * - allowedMxHosts: list of valid MX patterns to check against
 */
export async function getStsTlsOptions(
	redis: Redis,
	recipientDomain: string
): Promise<{
	requireTLS: boolean;
	rejectUnauthorized: boolean;
	allowedMxHosts: string[];
	policyMode: StsPolicyMode;
}> {
	const domain = recipientDomain.toLowerCase();

	try {
		const policy = await fetchOrCachedPolicy(redis, domain);

		if (policy.mode === 'enforce') {
			return {
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: policy.mx,
				policyMode: 'enforce',
			};
		}

		if (policy.mode === 'testing') {
			// Testing mode: don't enforce, but log for monitoring
			// nosemgrep -- MTA-STS testing mode is non-enforcing by spec (RFC 8461): monitor, never fail delivery.
			return {
				requireTLS: false,
				rejectUnauthorized: false,
				allowedMxHosts: policy.mx,
				policyMode: 'testing',
			};
		}
	} catch (err) {
		// MTA-STS errors must never prevent delivery — fall back to opportunistic TLS
		logger.debug({ domain, err }, 'MTA-STS lookup failed, using opportunistic TLS');
	}

	// nosemgrep -- no MTA-STS policy: opportunistic TLS (RFC 7435) — encrypt if offered, never fail delivery on an unverified cert.
	return {
		requireTLS: false,
		rejectUnauthorized: false,
		allowedMxHosts: [],
		policyMode: 'none',
	};
}

/**
 * Validate that an MX hostname matches the MTA-STS policy
 */
export function isMxAllowed(mxHost: string, allowedPatterns: string[]): boolean {
	if (allowedPatterns.length === 0) return true;

	const mx = mxHost.toLowerCase().replace(/\.$/, ''); // Strip trailing dot

	for (const pattern of allowedPatterns) {
		const p = pattern.toLowerCase().replace(/\.$/, '');

		if (p === mx) return true;

		// Wildcard matching: *.example.com matches any hostname under example.com
		// Per RFC 8461 §4.1: wildcards match any subdomain depth
		// e.g., *.google.com matches mail.google.com AND aspmx.l.google.com
		if (p.startsWith('*.')) {
			const suffix = p.slice(1); // ".example.com"
			if (mx.endsWith(suffix) && mx.length > suffix.length) return true;
		}
	}

	return false;
}

/**
 * Fetch or retrieve cached MTA-STS policy for a domain
 */
async function fetchOrCachedPolicy(redis: Redis, domain: string): Promise<StsPolicy> {
	const cacheKey = `${STS_CACHE_PREFIX}${domain}`;

	// Try cache first. An entry past cachedAt + max_age is kept only to
	// throttle the refetch; it is never applied.
	const entry = parseCachedPolicy(await redis.get(cacheKey));
	const now = Date.now();
	const cachedPolicy = entry && !isExpired(entry, now) ? entry : null;

	// Check DNS for _mta-sts TXT record. RFC 8461 §5.1: the DNS TXT `id` is the
	// authoritative version marker — a recipient signals a policy change (e.g.
	// testing->enforce, or MX rotation after a compromise) by bumping `id`.
	// We MUST re-check it even on a cache hit, otherwise an updated policy is
	// ignored for the whole TTL.
	const dnsVersion = await lookupStsDnsRecord(domain);

	if (cachedPolicy) {
		// Cheap path: cached id still matches the DNS id (or DNS is currently
		// unreachable) — keep serving the cached policy without an HTTP fetch.
		if (!dnsVersion || cachedPolicy.version === dnsVersion) {
			return cachedPolicy;
		}
		// id changed: the recipient updated their policy. Re-fetch the policy
		// file and re-cache against the new id. RFC 8461 §5.1/§6.2: a policy
		// fetch failure MUST NOT discard an unexpired cached policy — if the
		// re-fetch fails (HTTPS blocked / cert invalid / 5xx / a body that is
		// not a valid policy) we keep serving
		// the still-valid cached enforce policy rather than downgrading to
		// opportunistic TLS, which an on-path attacker who spoofs the DNS id
		// and blocks the fetch could otherwise exploit to strip STARTTLS.
		try {
			return await refetchAndCache(redis, cacheKey, domain, dnsVersion);
		} catch (err) {
			logger.warn({ domain, err }, 'MTA-STS re-fetch on id change failed; serving cached policy');
			return cachedPolicy;
		}
	}

	if (!dnsVersion) {
		// No MTA-STS record — cache negative result
		const noPolicy: StsPolicy = {
			mode: 'none',
			mx: [],
			maxAge: STS_DNS_NEGATIVE_CACHE_TTL,
			version: '',
			cachedAt: Date.now(),
		};
		await redis.set(cacheKey, JSON.stringify(noPolicy), 'EX', STS_DNS_NEGATIVE_CACHE_TTL);
		return noPolicy;
	}

	// An expired policy fetched moments ago: no policy applies until the
	// throttle window passes.
	if (entry && now - entry.cachedAt < STS_REFETCH_THROTTLE_SECONDS * 1000) {
		return { mode: 'none', mx: [], maxAge: 0, version: entry.version, cachedAt: entry.cachedAt };
	}

	// Cold cache: no prior policy to fall back to, so a fetch failure correctly
	// bubbles up to opportunistic TLS.
	return refetchAndCache(redis, cacheKey, domain, dnsVersion);
}

function isExpired(policy: StsPolicy, now: number): boolean {
	return now >= policy.cachedAt + policy.maxAge * 1000;
}

/** A cached entry, or null when it is missing or not a well-formed policy. */
function parseCachedPolicy(raw: string | null): StsPolicy | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<StsPolicy>;
		const wellFormed =
			STS_MODES.includes(value.mode as StsPolicyMode) &&
			Array.isArray(value.mx) &&
			value.mx.every((mx) => typeof mx === 'string') &&
			Number.isFinite(value.maxAge) &&
			Number.isFinite(value.cachedAt) &&
			typeof value.version === 'string';
		return wellFormed ? (value as StsPolicy) : null;
	} catch {
		return null;
	}
}

/**
 * Fetch the policy file via HTTPS and cache it against the given DNS version id.
 */
async function refetchAndCache(
	redis: Redis,
	cacheKey: string,
	domain: string,
	dnsVersion: string
): Promise<StsPolicy> {
	const policy = await fetchStsPolicy(domain, dnsVersion);

	// Keep the entry through max_age, and at least through the refetch throttle.
	const cacheTtl = Math.max(policy.maxAge, STS_REFETCH_THROTTLE_SECONDS);
	await redis.set(cacheKey, JSON.stringify(policy), 'EX', cacheTtl);

	logger.info(
		{
			domain,
			mode: policy.mode,
			mx: policy.mx.slice(0, STS_LOGGED_MX_ENTRIES),
			mxCount: policy.mx.length,
			maxAge: policy.maxAge,
		},
		'MTA-STS policy cached'
	);

	return policy;
}

/**
 * Look up the _mta-sts DNS TXT record for a domain
 * Returns the policy version ID, or null if no record exists
 *
 * Expected format: "v=STSv1; id=20190429T010101;"
 */
async function lookupStsDnsRecord(domain: string): Promise<string | null> {
	try {
		const records = await resolveTxt(`_mta-sts.${domain}`);
		// TXT records come as arrays of strings that need to be joined
		for (const record of records) {
			const txt = record.join('');
			if (txt.startsWith('v=STSv1')) {
				const idMatch = txt.match(/id=([^;\s]+)/);
				return idMatch?.[1] ?? null;
			}
		}
		return null;
	} catch {
		// NXDOMAIN, SERVFAIL, timeout — no MTA-STS for this domain
		return null;
	}
}

/**
 * Fetch and parse the MTA-STS policy file from a domain
 *
 * URL: https://mta-sts.{domain}/.well-known/mta-sts.txt
 *
 * Policy format (line-delimited key:value):
 *   version: STSv1
 *   mode: enforce
 *   mx: *.google.com
 *   mx: mail.google.com
 *   max_age: 86400
 *
 * The HTTPS GET and its bounds (redirects, address policy, status, media type,
 * size, timeout) live in mtaStsFetch.ts. Every failure throws, an invalid
 * policy included, so callers keep a cached policy.
 */
export async function fetchStsPolicy(domain: string, dnsVersion: string): Promise<StsPolicy> {
	return parseStsPolicy(await fetchStsPolicyText(domain), dnsVersion);
}

/**
 * Parse an MTA-STS policy text file (RFC 8461 §3.2).
 *
 * A valid policy has `version: STSv1`, a `mode` of enforce, testing or none,
 * and a non-negative integer `max_age`. Enforce and testing also need at least
 * one `mx`. Unknown fields are ignored. Anything else throws
 * {@link InvalidStsPolicyError} rather than returning mode 'none': only an
 * explicit `mode: none` policy may replace a cached one. An HTML error page,
 * a future "STSv2" body or an enforce policy with no mx must not quietly
 * downgrade a live enforce policy.
 *
 * Without the mx check an empty list would reach isMxAllowed, whose
 * `length === 0` short-circuit allows every MX host under enforce.
 *
 * The fetch's 64 KiB cap bounds how much this has to parse.
 */
export function parseStsPolicy(text: string, version: string): StsPolicy {
	let hasValidVersion = false;
	let mode: StsPolicyMode | undefined;
	let modeValue: string | undefined;
	const mx: string[] = [];
	let maxAgeValue: string | undefined;

	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		const colonIndex = line.indexOf(':');
		if (colonIndex === -1) continue;

		const key = line.substring(0, colonIndex).trim().toLowerCase();
		const value = line.substring(colonIndex + 1).trim();

		switch (key) {
			case 'version':
				hasValidVersion = value.toLowerCase() === 'stsv1';
				break;
			case 'mode':
				modeValue = value;
				mode = STS_MODES.find((m) => m === value);
				break;
			case 'mx':
				mx.push(value);
				break;
			case 'max_age':
				maxAgeValue = value;
				break;
		}
	}

	if (!hasValidVersion) {
		throw new InvalidStsPolicyError('MTA-STS policy has no `version: STSv1` line');
	}
	if (!mode) {
		throw new InvalidStsPolicyError(`MTA-STS policy mode is ${modeValue ?? 'missing'}`);
	}
	const maxAge = parseMaxAge(maxAgeValue);
	if (maxAge === undefined) {
		throw new InvalidStsPolicyError(`MTA-STS policy max_age is ${maxAgeValue ?? 'missing'}`);
	}
	if (mode !== 'none' && mx.length === 0) {
		throw new InvalidStsPolicyError(`MTA-STS ${mode} policy lists no mx`);
	}

	return { mode, mx: mode === 'none' ? [] : mx, maxAge, version, cachedAt: Date.now() };
}

/**
 * Parse a raw max_age: a non-negative integer (RFC 8461 §3.2), capped at the
 * one-year maximum. `undefined` when missing, negative or not a number.
 */
function parseMaxAge(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	return Math.min(Number.parseInt(value, 10), STS_MAX_AGE_CEILING);
}
