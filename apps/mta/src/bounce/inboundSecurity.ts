/**
 * Inbound SMTP Security
 *
 * Rate limiting, SPF validation, and connection tracking
 * for the bounce/inbound SMTP server.
 */

import type Redis from 'ioredis';
import { resolve as dnsResolve } from 'dns/promises';
import { emailDomain } from '@owlat/shared/spfAlignment';
import type { SpfVerdict } from './types.js';

const CONNECTION_PREFIX = 'mta:bounce:conn:';
const CONNECTION_TTL = 300; // 5 minute window for tracking

// ─── Per-IP Connection Rate Limiting ────────────────────────────────

/**
 * Check if a new connection from the given IP is allowed.
 * Uses a Redis counter with TTL to track concurrent connections per IP.
 *
 * @returns true if the connection is allowed
 */
export async function checkConnectionRateLimit(
	redis: Redis,
	remoteIp: string,
	maxConnectionsPerIp: number
): Promise<boolean> {
	const key = `${CONNECTION_PREFIX}${normalizeIp(remoteIp)}`;

	const count = await redis.incr(key);
	// Set TTL only on first increment (key creation)
	if (count === 1) {
		await redis.expire(key, CONNECTION_TTL);
	}

	if (count > maxConnectionsPerIp) {
		// Decrement back since we're rejecting
		await redis.decr(key);
		return false;
	}

	return true;
}

/**
 * Release a connection slot when a client disconnects
 */
export async function releaseConnection(redis: Redis, remoteIp: string): Promise<void> {
	const key = `${CONNECTION_PREFIX}${normalizeIp(remoteIp)}`;
	const count = await redis.decr(key);
	// Cleanup if counter reaches 0 or goes negative
	if (count <= 0) {
		await redis.del(key);
	}
}

/**
 * Get current connection count for an IP (for monitoring)
 */
export async function getConnectionCount(redis: Redis, remoteIp: string): Promise<number> {
	const key = `${CONNECTION_PREFIX}${normalizeIp(remoteIp)}`;
	const count = await redis.get(key);
	return count ? parseInt(count, 10) : 0;
}

// ─── SPF Validation ─────────────────────────────────────────────────

export interface SpfResult {
	result: SpfVerdict;
	explanation?: string;
}

/**
 * RFC 7208 §4.6.4: an SPF evaluation may cause at most 10 DNS lookups via
 * a/mx/include/redirect/exists (and §4.6.4 para 3: at most 10 MX host lookups
 * per mx term). Without this budget — and without include-cycle detection —
 * two mutually including TXT records turn every MAIL FROM into an unbounded
 * pre-auth DNS/CPU loop on the public listener.
 */
const MAX_SPF_DNS_LOOKUPS = 10;
const MAX_SPF_MX_HOSTS = 10;
/**
 * RFC 7208 §4.6.4: an SPF evaluation must produce a permerror once it has seen
 * more than two "void lookups" — DNS queries that return NXDOMAIN (RCODE 3) or
 * a positive answer with zero records (NODATA). This caps the amplification a
 * misconfigured/abusive record can extract from us via a/mx/exists/include
 * terms that each resolve to nothing.
 */
const MAX_SPF_VOID_LOOKUPS = 2;
const SPF_OVERALL_TIMEOUT_MS = 20_000;

interface SpfBudget {
	lookups: number;
	voids: number;
	visited: Set<string>;
}

/** Returns false when the RFC 7208 lookup budget is exhausted. */
function consumeLookup(budget: SpfBudget): boolean {
	if (budget.lookups >= MAX_SPF_DNS_LOOKUPS) return false;
	budget.lookups += 1;
	return true;
}

/** Sentinel thrown to abort evaluation with a definite SPF result. */
class SpfAbort {
	constructor(public readonly result: SpfResult) {}
}

/** Re-throw an SpfAbort so per-mechanism catch blocks can't swallow it. */
function rethrowAbort(err: unknown): void {
	if (err instanceof SpfAbort) throw err;
}

/**
 * Resolve a DNS record while enforcing the §4.6.4 void-lookup cap.
 *
 * A query that returns nothing (NXDOMAIN/NODATA, surfaced as ENOTFOUND/ENODATA
 * or an empty answer) is a "void lookup". The third such lookup aborts the whole
 * evaluation with a permerror — note this means we stop issuing further DNS
 * queries for the term that tripped the cap. Any other DNS error (e.g. SERVFAIL)
 * is a temporary failure and is re-thrown so the caller can map it per §5.2.
 */
async function resolveCounted<T>(
	domain: string,
	type: 'A' | 'AAAA' | 'MX' | 'TXT',
	budget: SpfBudget,
): Promise<T[]> {
	let records: T[];
	try {
		records = (await dnsResolve(domain, type)) as unknown as T[];
	} catch (err: unknown) {
		const code = (err as { code?: string }).code;
		if (code === 'ENOTFOUND' || code === 'ENODATA') {
			countVoid(budget);
			return [];
		}
		throw err;
	}
	if (records.length === 0) {
		countVoid(budget);
	}
	return records;
}

/** Record one void lookup; abort with permerror once the §4.6.4 cap is passed. */
function countVoid(budget: SpfBudget): void {
	budget.voids += 1;
	if (budget.voids > MAX_SPF_VOID_LOOKUPS) {
		throw new SpfAbort({
			result: 'permerror',
			explanation: 'SPF void DNS lookup limit exceeded',
		});
	}
}

/**
 * Perform SPF validation for an inbound email.
 *
 * Checks the sender's domain SPF record against the connecting IP.
 * This is a simplified SPF checker that handles the most common cases:
 * - ip4/ip6 mechanisms
 * - include mechanisms (recursive, RFC 7208 10-lookup budget + cycle detection)
 * - a/mx mechanisms
 * - all mechanism
 *
 * For production use with full RFC 7208 compliance, consider the `mailauth` package.
 */
export async function checkSpf(
	senderIp: string,
	mailFrom: string,
	_ehloHostname: string
): Promise<SpfResult> {
	const domain = emailDomain(mailFrom);
	if (!domain) {
		return { result: 'none', explanation: 'No domain in MAIL FROM' };
	}

	try {
		const records = await dnsResolve(domain, 'TXT');
		const spfRecord = records
			.flat()
			.find(r => r.startsWith('v=spf1 '));

		if (!spfRecord) {
			return { result: 'none', explanation: 'No SPF record found' };
		}

		// Overall wall-clock ceiling: the SMTP socket timeout does not cancel an
		// in-flight async handler, so a slow/malicious DNS chain must time out
		// here rather than leak an immortal evaluation task.
		const budget: SpfBudget = { lookups: 0, voids: 0, visited: new Set([domain.toLowerCase()]) };
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				evaluateSpf(spfRecord, senderIp, domain, budget).catch((err: unknown) => {
					// A void-lookup-cap breach unwinds the recursion as an SpfAbort.
					if (err instanceof SpfAbort) return err.result;
					throw err;
				}),
				new Promise<SpfResult>((resolveTimeout) => {
					timer = setTimeout(
						() => resolveTimeout({ result: 'temperror', explanation: 'SPF evaluation timed out' }),
						SPF_OVERALL_TIMEOUT_MS,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	} catch (err: unknown) {
		const error = err as { code?: string };
		if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') {
			return { result: 'none', explanation: 'Domain has no DNS records' };
		}
		return { result: 'temperror', explanation: `DNS lookup failed: ${error.code}` };
	}
}

/**
 * Evaluate an SPF record against a sender IP
 */
async function evaluateSpf(
	spfRecord: string,
	senderIp: string,
	domain: string,
	budget: SpfBudget
): Promise<SpfResult> {
	const normalizedIp = normalizeIp(senderIp);
	const terms = spfRecord.split(/\s+/).slice(1); // Skip "v=spf1"

	// redirect= is a modifier, not a mechanism: it only applies if no mechanism
	// matched and there is no `all` (RFC 7208 §6.1). Capture it up front so its
	// position in the record doesn't matter.
	let redirectTarget: string | undefined;

	for (const mechanism of terms) {
		// Modifiers (name=value) — only redirect= affects evaluation; exp= and any
		// unknown modifier are ignored, but must not fall through to mechanism parsing.
		if (/^[a-z][a-z0-9._-]*=/i.test(mechanism)) {
			const eq = mechanism.indexOf('=');
			const name = mechanism.slice(0, eq).toLowerCase();
			if (name === 'redirect') {
				redirectTarget = mechanism.slice(eq + 1);
			}
			continue;
		}

		// Parse qualifier (+, -, ~, ?)
		let qualifier = '+'; // Default is pass
		let mech = mechanism;
		if (/^[+\-~?]/.test(mech)) {
			qualifier = mech[0]!;
			mech = mech.slice(1);
		}

		const qualifierResult = mapQualifier(qualifier);

		// ip4:
		if (mech.startsWith('ip4:')) {
			const cidr = mech.slice(4);
			if (ipMatchesCidr(normalizedIp, cidr)) {
				return { result: qualifierResult };
			}
			continue;
		}

		// ip6: — RFC 7208 §5.6, with prefix-length (CIDR) support.
		if (mech.startsWith('ip6:')) {
			const ip6 = mech.slice(4);
			if (ipv6MatchesCidr(normalizedIp, ip6)) {
				return { result: qualifierResult };
			}
			continue;
		}

		// a mechanism (check domain's A records)
		if (mech === 'a' || mech.startsWith('a:')) {
			const targetDomain = mech === 'a' ? domain : mech.slice(2);
			if (!consumeLookup(budget)) {
				return { result: 'permerror', explanation: 'SPF DNS lookup limit exceeded' };
			}
			try {
				const aRecords = await resolveCounted<string>(targetDomain, 'A', budget);
				if (aRecords.includes(normalizedIp) || aRecords.includes(stripIpv4Prefix(normalizedIp))) {
					return { result: qualifierResult };
				}
			} catch (err) {
				rethrowAbort(err);
				// Non-void DNS error (e.g. SERVFAIL) — continue to next mechanism.
			}
			continue;
		}

		// mx mechanism (check domain's MX records' A records)
		if (mech === 'mx' || mech.startsWith('mx:')) {
			const targetDomain = mech === 'mx' ? domain : mech.slice(3);
			if (!consumeLookup(budget)) {
				return { result: 'permerror', explanation: 'SPF DNS lookup limit exceeded' };
			}
			try {
				const mxRecords = await resolveCounted<{ exchange: string; priority: number } | string>(
					targetDomain,
					'MX',
					budget,
				);
				for (const mx of mxRecords.slice(0, MAX_SPF_MX_HOSTS)) {
					try {
						const mxHost = typeof mx === 'string' ? mx : mx.exchange;
						const mxARecords = await resolveCounted<string>(mxHost, 'A', budget);
						if (mxARecords.includes(normalizedIp) || mxARecords.includes(stripIpv4Prefix(normalizedIp))) {
							return { result: qualifierResult };
						}
					} catch (err) {
						rethrowAbort(err);
						// Individual MX host A lookup failure — continue
					}
				}
			} catch (err) {
				rethrowAbort(err);
				// Non-void DNS error (e.g. SERVFAIL) — continue
			}
			continue;
		}

		// include: (recursive SPF lookup, one level deep)
		if (mech.startsWith('include:')) {
			const includeDomain = expandMacros(mech.slice(8), normalizedIp, domain);
			if (budget.visited.has(includeDomain.toLowerCase())) {
				return { result: 'permerror', explanation: `SPF include cycle via ${includeDomain}` };
			}
			if (!consumeLookup(budget)) {
				return { result: 'permerror', explanation: 'SPF DNS lookup limit exceeded' };
			}
			budget.visited.add(includeDomain.toLowerCase());

			// RFC 7208 §5.2: the TXT lookup that backs an include is itself part of
			// SPF evaluation. A temporary DNS error (e.g. SERVFAIL) maps to temperror
			// — it must NOT be silently swallowed and treated as "no match".
			let includeRecords: string[][];
			try {
				includeRecords = await resolveCounted<string[]>(includeDomain, 'TXT', budget);
			} catch (err: unknown) {
				rethrowAbort(err);
				return {
					result: 'temperror',
					explanation: `SPF include TXT lookup failed for ${includeDomain}: ${(err as { code?: string }).code ?? 'error'}`,
				};
			}
			const includeSpf = includeRecords
				.flat()
				.find(r => r.startsWith('v=spf1 '));
			// §5.2 result table: a "none" from the included record (missing/invalid
			// SPF) is a permerror for the including record.
			if (!includeSpf) {
				return { result: 'permerror', explanation: `Included domain ${includeDomain} has no SPF record` };
			}
			const includeResult = await evaluateSpf(includeSpf, senderIp, includeDomain, budget);
			switch (includeResult.result) {
				case 'pass':
					return { result: qualifierResult };
				case 'temperror':
				case 'permerror':
					return includeResult;
				case 'none':
					return { result: 'permerror', explanation: `Included domain ${includeDomain} produced no result` };
				default:
					// fail / softfail / neutral from the include = no match — continue.
					break;
			}
			continue;
		}

		// exists: (RFC 7208 §5.7) — macro-expand the target, then a single A lookup;
		// the mechanism matches iff *any* A record exists (the IP is irrelevant).
		if (mech.startsWith('exists:')) {
			const target = expandMacros(mech.slice(7), normalizedIp, domain);
			if (!consumeLookup(budget)) {
				return { result: 'permerror', explanation: 'SPF DNS lookup limit exceeded' };
			}
			try {
				const aRecords = await resolveCounted<string>(target, 'A', budget);
				if (aRecords.length > 0) {
					return { result: qualifierResult };
				}
			} catch (err) {
				rethrowAbort(err);
				// Non-void DNS error (e.g. SERVFAIL) — continue
			}
			continue;
		}

		// all mechanism (catch-all)
		if (mech === 'all') {
			return { result: qualifierResult };
		}
	}

	// RFC 7208 §6.1: a redirect= modifier is only applied once all mechanisms
	// failed to match (and an `all` would already have returned above). The
	// redirected record's result IS the result — there is no qualifier and no
	// fallback to neutral on a sub-error.
	if (redirectTarget) {
		const target = expandMacros(redirectTarget, normalizedIp, domain);
		if (budget.visited.has(target.toLowerCase())) {
			return { result: 'permerror', explanation: `SPF redirect cycle via ${target}` };
		}
		if (!consumeLookup(budget)) {
			return { result: 'permerror', explanation: 'SPF DNS lookup limit exceeded' };
		}
		budget.visited.add(target.toLowerCase());
		let redirectRecords: string[][];
		try {
			redirectRecords = await resolveCounted<string[]>(target, 'TXT', budget);
		} catch (err: unknown) {
			rethrowAbort(err);
			return {
				result: 'temperror',
				explanation: `SPF redirect TXT lookup failed for ${target}: ${(err as { code?: string }).code ?? 'error'}`,
			};
		}
		const redirectSpf = redirectRecords
			.flat()
			.find(r => r.startsWith('v=spf1 '));
		// §6.1: a redirect to a domain with no usable SPF record is a permerror.
		if (!redirectSpf) {
			return { result: 'permerror', explanation: `SPF redirect target ${target} has no SPF record` };
		}
		return evaluateSpf(redirectSpf, senderIp, target, budget);
	}

	// No mechanism matched and no redirect — neutral
	return { result: 'neutral', explanation: 'No SPF mechanism matched' };
}

/**
 * Expand the subset of RFC 7208 §7 macros that affect host lookups.
 *
 * Supports `%{i}` (sender IP, dotted-quad for IPv4 / nibble form for IPv6),
 * `%{d}` (current domain), `%{o}`/`%{s}` (sender — we only know the domain part),
 * and the literals `%%`, `%_`, `%-`. Macro modifiers (digit transformers,
 * reversal, alternate delimiters) are intentionally not implemented; an
 * unrecognised macro is left verbatim so the resulting lookup simply misses
 * rather than throwing — adequate for the common `exists:%{i}...` idiom.
 */
function expandMacros(input: string, senderIp: string, domain: string): string {
	if (!input.includes('%')) return input;
	return input.replace(/%\{([a-zA-Z])\}|%%|%_|%-/g, (match, letter?: string) => {
		if (match === '%%') return '%';
		if (match === '%_') return ' ';
		if (match === '%-') return '%20';
		switch ((letter ?? '').toLowerCase()) {
			case 'i':
				return macroIp(senderIp);
			case 'd':
				return domain;
			case 's':
			case 'o':
				return domain;
			default:
				return match;
		}
	});
}

/** Macro %{i} expansion: dotted-quad for IPv4, dot-separated nibbles for IPv6. */
function macroIp(ip: string): string {
	const v4 = stripIpv4Prefix(ip);
	if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
		return v4;
	}
	// IPv6: expand to 32 hex nibbles separated by dots (best-effort).
	const expanded = expandIpv6(ip);
	if (expanded) {
		return expanded.split('').join('.');
	}
	return ip;
}

/** Expand an IPv6 address to its 32-nibble hex string, or null if unparsable. */
function expandIpv6(ip: string): string | null {
	if (!ip.includes(':')) return null;
	const halves = ip.split('::');
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0]!.split(':') : [];
	const tail = halves.length === 2 ? (halves[1] ? halves[1]!.split(':') : []) : [];
	const missing = 8 - head.length - tail.length;
	if (missing < 0) return null;
	const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
	if (groups.length !== 8) return null;
	let out = '';
	for (const g of groups) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
		out += g.toLowerCase().padStart(4, '0');
	}
	return out;
}

// ─── Helpers ────────────────────────────────────────────────────────

function normalizeIp(ip: string): string {
	// Strip IPv4-mapped IPv6 prefix
	if (ip.startsWith('::ffff:')) {
		return ip.slice(7);
	}
	return ip;
}

function stripIpv4Prefix(ip: string): string {
	if (ip.startsWith('::ffff:')) {
		return ip.slice(7);
	}
	return ip;
}

function mapQualifier(q: string): SpfResult['result'] {
	switch (q) {
		case '+': return 'pass';
		case '-': return 'fail';
		case '~': return 'softfail';
		case '?': return 'neutral';
		default: return 'neutral';
	}
}

/**
 * Check if an IP matches a CIDR range (IPv4 only)
 * Handles both plain IPs and CIDR notation (e.g., 10.0.0.0/24)
 */
function ipMatchesCidr(ip: string, cidr: string): boolean {
	const normalizedIp = stripIpv4Prefix(ip);

	// Plain IP comparison
	if (!cidr.includes('/')) {
		return normalizedIp === cidr;
	}

	const [network, prefixLenStr] = cidr.split('/');
	const prefixLen = parseInt(prefixLenStr!, 10);

	if (!network || isNaN(prefixLen)) return false;

	const ipNum = ipToNumber(normalizedIp);
	const netNum = ipToNumber(network);

	if (ipNum === null || netNum === null) return false;

	const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
	return (ipNum & mask) === (netNum & mask);
}

function ipToNumber(ip: string): number | null {
	const parts = ip.split('.');
	if (parts.length !== 4) return null;

	let result = 0;
	for (const part of parts) {
		const num = parseInt(part, 10);
		if (isNaN(num) || num < 0 || num > 255) return null;
		result = (result << 8) | num;
	}

	return result >>> 0;
}

/**
 * RFC 7208 §5.6: an `ip6:` mechanism may carry a CIDR prefix length, in which
 * case the connecting IP matches when its leading `prefixLen` bits equal the
 * network's. Without this, a sender covered by a legitimate `ip6:2001:db8::/32`
 * record (e.g. a large provider like Microsoft) is wrongly scored non-matching
 * because the old code only did an exact address comparison.
 *
 * Handles both a bare address (`2001:db8::1`, exact match) and a CIDR
 * (`2001:db8::/32`, prefix match). Returns false for any unparsable IPv6 input
 * or a prefix length outside 0–128.
 */
function ipv6MatchesCidr(ip: string, cidr: string): boolean {
	const slash = cidr.indexOf('/');
	const network = slash === -1 ? cidr : cidr.slice(0, slash);
	const prefixLen = slash === -1 ? 128 : parseInt(cidr.slice(slash + 1), 10);
	if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 128) return false;

	const ipNibbles = expandIpv6(ip);
	const netNibbles = expandIpv6(network);
	if (ipNibbles === null || netNibbles === null) return false;

	// Both are 32-nibble (128-bit) hex strings. Compare the leading `prefixLen`
	// bits: whole nibbles first, then the partial nibble straddling the boundary.
	const fullNibbles = Math.floor(prefixLen / 4);
	if (ipNibbles.slice(0, fullNibbles) !== netNibbles.slice(0, fullNibbles)) {
		return false;
	}
	const remainingBits = prefixLen % 4;
	if (remainingBits === 0) return true;

	const mask = 0xf & (0xf << (4 - remainingBits));
	const ipNibble = parseInt(ipNibbles[fullNibbles]!, 16);
	const netNibble = parseInt(netNibbles[fullNibbles]!, 16);
	return (ipNibble & mask) === (netNibble & mask);
}
