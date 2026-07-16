/**
 * RFC 7208 SPF evaluator.
 *
 * Moved verbatim (logic frozen — a move, not a rewrite) out of the MTA's
 * `apps/mta/src/bounce/inboundSecurity.ts`. The only additive change is an
 * INJECTABLE resolver: `checkSpf` now accepts an optional `SpfDnsResolver`
 * (defaulting to Node's `dns/promises` resolve) so the same evaluation can run
 * against a cached / hermetic resolver without touching the evaluation logic.
 * The RFC 7208 §4.6.4 lookup budget is still counted per mechanism, so a cache
 * that serves a term from Redis does NOT let a record exceed the 10-lookup cap.
 */

import { resolve as dnsResolve } from 'dns/promises';
import { emailDomain } from '@owlat/shared/spfAlignment';
import {
	normalizeIp,
	stripIpv4Prefix,
	ipMatchesCidr,
	ipv6MatchesCidr,
	expandMacros,
} from './ip.js';

/** RFC 7208 §2.6 / RFC 8601 SPF result keyword. */
export type SpfVerdict =
	| 'pass'
	| 'fail'
	| 'softfail'
	| 'neutral'
	| 'none'
	| 'temperror'
	| 'permerror';

export interface SpfResult {
	result: SpfVerdict;
	explanation?: string;
}

/**
 * The DNS surface SPF evaluation needs. Returns the raw record payload for the
 * requested type (TXT: `string[][]`, A/AAAA: `string[]`, MX: `{exchange,
 * priority}[]`). Throws on a transient DNS error (SERVFAIL etc.) and either
 * throws ENOTFOUND/ENODATA or returns an empty array for NXDOMAIN/NODATA —
 * `resolveCounted` treats both as a void lookup.
 */
export type SpfDnsResolver = (
	name: string,
	type: 'A' | 'AAAA' | 'MX' | 'TXT'
) => Promise<unknown[]>;

/** Default resolver: Node's `dns/promises` resolve (the production path). */
const defaultResolver: SpfDnsResolver = (name, type) =>
	dnsResolve(name, type) as unknown as Promise<unknown[]>;

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
	resolver: SpfDnsResolver
): Promise<T[]> {
	let records: T[];
	try {
		records = (await resolver(domain, type)) as unknown as T[];
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
 */
export async function checkSpf(
	senderIp: string,
	mailFrom: string,
	_ehloHostname: string,
	resolver: SpfDnsResolver = defaultResolver
): Promise<SpfResult> {
	const domain = emailDomain(mailFrom);
	if (!domain) {
		return { result: 'none', explanation: 'No domain in MAIL FROM' };
	}

	try {
		const records = (await resolver(domain, 'TXT')) as string[][];
		const spfRecord = records.flat().find((r) => r.startsWith('v=spf1 '));

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
				evaluateSpf(spfRecord, senderIp, domain, budget, resolver).catch((err: unknown) => {
					// A void-lookup-cap breach unwinds the recursion as an SpfAbort.
					if (err instanceof SpfAbort) return err.result;
					throw err;
				}),
				new Promise<SpfResult>((resolveTimeout) => {
					timer = setTimeout(
						() => resolveTimeout({ result: 'temperror', explanation: 'SPF evaluation timed out' }),
						SPF_OVERALL_TIMEOUT_MS
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
	budget: SpfBudget,
	resolver: SpfDnsResolver
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
				const aRecords = await resolveCounted<string>(targetDomain, 'A', budget, resolver);
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
					resolver
				);
				for (const mx of mxRecords.slice(0, MAX_SPF_MX_HOSTS)) {
					try {
						const mxHost = typeof mx === 'string' ? mx : mx.exchange;
						const mxARecords = await resolveCounted<string>(mxHost, 'A', budget, resolver);
						if (
							mxARecords.includes(normalizedIp) ||
							mxARecords.includes(stripIpv4Prefix(normalizedIp))
						) {
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
				includeRecords = await resolveCounted<string[]>(includeDomain, 'TXT', budget, resolver);
			} catch (err: unknown) {
				rethrowAbort(err);
				return {
					result: 'temperror',
					explanation: `SPF include TXT lookup failed for ${includeDomain}: ${(err as { code?: string }).code ?? 'error'}`,
				};
			}
			const includeSpf = includeRecords.flat().find((r) => r.startsWith('v=spf1 '));
			// §5.2 result table: a "none" from the included record (missing/invalid
			// SPF) is a permerror for the including record.
			if (!includeSpf) {
				return {
					result: 'permerror',
					explanation: `Included domain ${includeDomain} has no SPF record`,
				};
			}
			const includeResult = await evaluateSpf(
				includeSpf,
				senderIp,
				includeDomain,
				budget,
				resolver
			);
			switch (includeResult.result) {
				case 'pass':
					return { result: qualifierResult };
				case 'temperror':
				case 'permerror':
					return includeResult;
				case 'none':
					return {
						result: 'permerror',
						explanation: `Included domain ${includeDomain} produced no result`,
					};
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
				const aRecords = await resolveCounted<string>(target, 'A', budget, resolver);
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
			redirectRecords = await resolveCounted<string[]>(target, 'TXT', budget, resolver);
		} catch (err: unknown) {
			rethrowAbort(err);
			return {
				result: 'temperror',
				explanation: `SPF redirect TXT lookup failed for ${target}: ${(err as { code?: string }).code ?? 'error'}`,
			};
		}
		const redirectSpf = redirectRecords.flat().find((r) => r.startsWith('v=spf1 '));
		// §6.1: a redirect to a domain with no usable SPF record is a permerror.
		if (!redirectSpf) {
			return {
				result: 'permerror',
				explanation: `SPF redirect target ${target} has no SPF record`,
			};
		}
		return evaluateSpf(redirectSpf, senderIp, target, budget, resolver);
	}

	// No mechanism matched and no redirect — neutral
	return { result: 'neutral', explanation: 'No SPF mechanism matched' };
}

// ─── Helpers ────────────────────────────────────────────────────────

function mapQualifier(q: string): SpfVerdict {
	switch (q) {
		case '+':
			return 'pass';
		case '-':
			return 'fail';
		case '~':
			return 'softfail';
		case '?':
			return 'neutral';
		default:
			return 'neutral';
	}
}
