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
import { isRecord } from '@owlat/shared/utils/guards';
import { logger } from '../monitoring/logger.js';
import { fetchStsPolicyText, isLdhName } from './mtaStsFetch.js';
import { gatedPolicyFetch } from './mtaStsFetchGate.js';

const STS_CACHE_PREFIX = 'mta:sts:';
const STS_DNS_NEGATIVE_CACHE_TTL = 3600; // 1h cache for domains without MTA-STS
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

		// RFC 8461 §4.1: a wildcard stands for exactly one label, so
		// *.example.com matches mail.example.com but neither example.com nor
		// foo.mail.example.com.
		if (p.startsWith('*.')) {
			const suffix = p.slice(1); // ".example.com"
			const label = mx.slice(0, -suffix.length);
			if (mx.endsWith(suffix) && label !== '' && !label.includes('.')) return true;
		}
	}

	return false;
}

/**
 * Fetch or retrieve cached MTA-STS policy for a domain
 */
async function fetchOrCachedPolicy(redis: Redis, domain: string): Promise<StsPolicy> {
	const cacheKey = `${STS_CACHE_PREFIX}${domain}`;

	// Try cache first. A policy applies only until cachedAt + max_age.
	const entry = parseCachedPolicy(await redis.get(cacheKey));
	const cachedPolicy = entry && !isExpired(entry, Date.now()) ? entry : null;

	// Check DNS for _mta-sts TXT record. RFC 8461 §5.1: the DNS TXT `id` is the
	// authoritative version marker — a recipient signals a policy change (e.g.
	// testing->enforce, or MX rotation after a compromise) by bumping `id`.
	// We MUST re-check it even on a cache hit, otherwise an updated policy is
	// ignored for the whole TTL.
	const dnsVersion = await lookupStsDnsRecord(domain);

	// Cheap path: an unexpired policy whose id still matches the DNS id (or DNS
	// is currently unreachable) is served without an HTTP fetch.
	if (cachedPolicy && (!dnsVersion || cachedPolicy.version === dnsVersion)) {
		return cachedPolicy;
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

	// The cache is empty or expired, or DNS announces a new id: fetch, within
	// the per-id backoff and per-domain budget (mtaStsFetchGate.ts). A skipped
	// fetch means no fresh policy: keep the unexpired cached one, or apply none.
	try {
		const fresh = await gatedPolicyFetch(redis, domain, dnsVersion, () =>
			refetchAndCache(redis, cacheKey, domain, dnsVersion)
		);
		return fresh ?? cachedPolicy ?? noActivePolicy(dnsVersion);
	} catch (err) {
		// Cold or expired cache: nothing to fall back to, so the failure bubbles
		// up to opportunistic TLS.
		if (!cachedPolicy) throw err;
		// RFC 8461 §5.1/§6.2: a policy fetch failure MUST NOT discard an
		// unexpired cached policy. If the id-change re-fetch fails (HTTPS
		// blocked / cert invalid / 5xx / a body that is not a valid policy) we
		// keep serving the still-valid cached enforce policy rather than
		// downgrading to opportunistic TLS, which an on-path attacker who spoofs
		// the DNS id and blocks the fetch could otherwise exploit to strip
		// STARTTLS.
		logger.warn({ domain, err }, 'MTA-STS re-fetch on id change failed; serving cached policy');
		return cachedPolicy;
	}
}

function noActivePolicy(version: string): StsPolicy {
	return { mode: 'none', mx: [], maxAge: 0, version, cachedAt: Date.now() };
}

function isExpired(policy: StsPolicy, now: number): boolean {
	return now >= policy.cachedAt + policy.maxAge * 1000;
}

/** A cached entry, or null when it is missing or not a well-formed policy. */
function parseCachedPolicy(raw: string | null): StsPolicy | null {
	if (!raw) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(value)) return null;
	const { mode, mx, maxAge, version, cachedAt } = value;
	const policyMode = STS_MODES.find((known) => known === mode);
	if (
		policyMode === undefined ||
		!Array.isArray(mx) ||
		!mx.every((host): host is string => typeof host === 'string') ||
		typeof maxAge !== 'number' ||
		!Number.isFinite(maxAge) ||
		typeof cachedAt !== 'number' ||
		!Number.isFinite(cachedAt) ||
		typeof version !== 'string'
	) {
		return null;
	}
	return { mode: policyMode, mx, maxAge, version, cachedAt };
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

	// The entry lives exactly as long as the policy. A max_age 0 policy applies
	// to this delivery only, and replaces whatever was cached before it. A
	// failed write doesn't undo the fetch: the policy still applies now.
	try {
		if (policy.maxAge > 0) {
			await redis.set(cacheKey, JSON.stringify(policy), 'EX', policy.maxAge);
		} else {
			await redis.del(cacheKey);
		}
	} catch (err) {
		logger.warn({ domain, err }, 'MTA-STS policy fetched but not cached');
	}

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
 * one `mx`, and every `mx` must be a hostname or `*.` wildcard. For version,
 * mode and max_age the first occurrence wins. Unknown fields are ignored. Anything else throws
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
	let versionValue: string | undefined;
	let modeValue: string | undefined;
	const mx: string[] = [];
	let maxAgeValue: string | undefined;

	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		const colonIndex = line.indexOf(':');
		if (colonIndex === -1) continue;

		const key = line.substring(0, colonIndex).trim().toLowerCase();
		const value = line.substring(colonIndex + 1).trim();

		// RFC 8461 §3.2: for version, mode and max_age, only the first
		// occurrence counts; later ones are ignored.
		switch (key) {
			case 'version':
				versionValue ??= value;
				break;
			case 'mode':
				modeValue ??= value;
				break;
			case 'mx':
				if (!isMxPattern(value)) {
					throw new InvalidStsPolicyError(
						`MTA-STS policy mx ${JSON.stringify(value)} is not a hostname`
					);
				}
				mx.push(value);
				break;
			case 'max_age':
				maxAgeValue ??= value;
				break;
		}
	}

	if (versionValue?.toLowerCase() !== 'stsv1') {
		throw new InvalidStsPolicyError('MTA-STS policy has no `version: STSv1` line');
	}
	const mode = STS_MODES.find((m) => m === modeValue);
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
 * An mx value per RFC 8461 §3.2: a hostname, optionally with a leading `*.`
 * wildcard label. An empty or malformed value would cache an enforce policy
 * that no MX matches, which blocks delivery instead of protecting it.
 */
function isMxPattern(value: string): boolean {
	const name = value.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
	return name !== '' && isLdhName(name);
}

/**
 * Parse a raw max_age: a non-negative integer (RFC 8461 §3.2), capped at the
 * one-year maximum. `undefined` when missing, negative or not a number.
 */
function parseMaxAge(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	return Math.min(Number.parseInt(value, 10), STS_MAX_AGE_CEILING);
}
