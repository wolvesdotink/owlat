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
 * 3. Cache parsed policy in Redis with TTL from max_age
 * 4. Return TLS requirements for SMTP sender to apply
 */

import { resolveTxt } from 'dns/promises';
import type Redis from 'ioredis';
import { logger } from '../monitoring/logger.js';

const STS_CACHE_PREFIX = 'mta:sts:';
const STS_FETCH_TIMEOUT = 10_000; // 10s timeout for HTTP fetch
const STS_DNS_NEGATIVE_CACHE_TTL = 3600; // 1h cache for domains without MTA-STS
const STS_MIN_CACHE_TTL = 300; // Minimum 5 minutes regardless of max_age
// RFC 8461 §3.2: max_age has a maximum of 31557600 seconds (one year).
const STS_MAX_AGE_CEILING = 31_557_600;
const STS_DEFAULT_MAX_AGE = 86_400; // Default 1 day when max_age is absent/invalid

export type StsPolicyMode = 'enforce' | 'testing' | 'none';

export interface StsPolicy {
	/** Policy mode: enforce (require TLS), testing (report-only), none (no policy) */
	mode: StsPolicyMode;
	/** Allowed MX hostname patterns (e.g., ["*.google.com", "mail.google.com"]) */
	mx: string[];
	/** Max age in seconds (from policy) */
	maxAge: number;
	/** Policy version ID from DNS TXT record */
	version: string;
	/** When this policy was cached */
	cachedAt: number;
}

/**
 * Get MTA-STS TLS options for a recipient domain
 *
 * Returns connection overrides for nodemailer transport:
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

	// Try cache first
	const cached = await redis.get(cacheKey);
	let cachedPolicy: StsPolicy | null = null;
	if (cached) {
		try {
			cachedPolicy = JSON.parse(cached) as StsPolicy;
		} catch {
			// Invalid cache entry, refetch
			cachedPolicy = null;
		}
	}

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
		// re-fetch fails (HTTPS blocked / cert invalid / 5xx) we keep serving
		// the still-valid cached enforce policy rather than downgrading to
		// opportunistic TLS, which an on-path attacker who spoofs the DNS id
		// and blocks the fetch could otherwise exploit to strip STARTTLS.
		try {
			return await refetchAndCache(redis, cacheKey, domain, dnsVersion);
		} catch (err) {
			logger.warn(
				{ domain, err },
				'MTA-STS re-fetch on id change failed; serving cached policy'
			);
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

	// Cold cache: no prior policy to fall back to, so a fetch failure correctly
	// bubbles up to opportunistic TLS.
	return refetchAndCache(redis, cacheKey, domain, dnsVersion);
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

	// Cache with TTL from policy max_age (minimum 5 minutes)
	const cacheTtl = Math.max(policy.maxAge, STS_MIN_CACHE_TTL);
	await redis.set(cacheKey, JSON.stringify(policy), 'EX', cacheTtl);

	logger.info(
		{ domain, mode: policy.mode, mx: policy.mx, maxAge: policy.maxAge },
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
 * Exported for regression testing of the exact URL, the non-2xx throw, and the
 * 10s abort (RFC 8461 §3.3 — policy retrieval via HTTPS GET).
 */
export async function fetchStsPolicy(domain: string, dnsVersion: string): Promise<StsPolicy> {
	const url = `https://mta-sts.${domain}/.well-known/mta-sts.txt`;

	const response = await fetch(url, {
		signal: AbortSignal.timeout(STS_FETCH_TIMEOUT),
		headers: { 'User-Agent': 'owlat-mta/0.1 (MTA-STS policy fetch)' },
	});

	if (!response.ok) {
		throw new Error(`MTA-STS policy fetch failed: ${response.status} ${response.statusText}`);
	}

	const text = await response.text();
	return parseStsPolicy(text, dnsVersion);
}

/**
 * Parse an MTA-STS policy text file
 *
 * Per RFC 8461 §3.2 a usable policy MUST begin with `version: STSv1`. A policy
 * with a missing/unknown version (e.g. a future "STSv2" body, or an HTML error
 * page served by a misconfigured host) is treated as "no usable policy"
 * (mode: 'none') so we fall back to opportunistic TLS rather than enforcing a
 * body we don't actually understand.
 */
export function parseStsPolicy(text: string, version: string): StsPolicy {
	const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

	let hasValidVersion = false;
	let mode: StsPolicyMode = 'none';
	const mx: string[] = [];
	// `undefined` means max_age was absent/invalid; default only applies to a
	// usable enforcing/testing policy (mode: 'none' keeps max_age 0).
	let maxAge: number | undefined;

	for (const line of lines) {
		const colonIndex = line.indexOf(':');
		if (colonIndex === -1) continue;

		const key = line.substring(0, colonIndex).trim().toLowerCase();
		const value = line.substring(colonIndex + 1).trim();

		switch (key) {
			case 'version':
				if (value.toLowerCase() === 'stsv1') {
					hasValidVersion = true;
				}
				break;
			case 'mode':
				if (value === 'enforce' || value === 'testing' || value === 'none') {
					mode = value;
				}
				break;
			case 'mx':
				mx.push(value);
				break;
			case 'max_age':
				maxAge = parseMaxAge(value);
				break;
		}
	}

	if (!hasValidVersion) {
		// Missing or unsupported version line — not a usable STSv1 policy.
		return { mode: 'none', mx: [], maxAge: 0, version, cachedAt: Date.now() };
	}

	// RFC 8461 §3.2: a policy with mode `enforce` or `testing` MUST list at least
	// one `mx`. A version-valid policy that names NO MX is malformed — treat it as
	// "no usable policy" (mode: 'none') rather than enforcing it. Without this
	// guard an empty mx list reaches isMxAllowed, whose `length === 0` short-circuit
	// returns allow-all, which under `enforce` would silently permit EVERY MX host
	// (a STARTTLS-stripping / MX-substitution bypass) instead of failing closed.
	if ((mode === 'enforce' || mode === 'testing') && mx.length === 0) {
		return { mode: 'none', mx: [], maxAge: 0, version, cachedAt: Date.now() };
	}

	const resolvedMaxAge = resolveMaxAge(mode, maxAge);

	return { mode, mx, maxAge: resolvedMaxAge, version, cachedAt: Date.now() };
}

/**
 * Parse a raw max_age value. Returns the integer seconds when valid, or
 * `undefined` for a missing/non-numeric/negative value (RFC 8461 §3.2: max_age
 * is a non-negative integer).
 */
function parseMaxAge(value: string): number | undefined {
	if (!/^\d+$/.test(value.trim())) {
		// Non-digit (incl. negative "-5", "abc", "") — never accept as max_age.
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Resolve the effective max_age for a usable policy.
 * - mode 'none': preserve 0 (an explicit "no policy" carries no positive TTL).
 * - missing/invalid max_age: fall back to the 1-day default.
 * - otherwise clamp into [0, RFC ceiling] (31557600s per §3.2).
 */
function resolveMaxAge(mode: StsPolicyMode, maxAge: number | undefined): number {
	if (maxAge === undefined) {
		// Absent/invalid: an explicit mode:none policy stays at 0, others default.
		return mode === 'none' ? 0 : STS_DEFAULT_MAX_AGE;
	}
	// Clamp into the RFC-permitted range. parseMaxAge already rejects negatives,
	// but Math.max keeps the floor robust against any future caller.
	return Math.min(Math.max(maxAge, 0), STS_MAX_AGE_CEILING);
}
