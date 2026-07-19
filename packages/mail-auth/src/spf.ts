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
	ipMatchesCidr,
	ipv6MatchesCidr,
	expandMacros,
	isValidIpv4Cidr,
	isValidIpv6Cidr,
	SpfMacroError,
	type SpfMacroContext,
} from './ip.js';
import {
	addressMatchesSender,
	dnsTemperror,
	parseAddressMechanism,
	senderAddressType,
} from './spfMechanism.js';
import {
	consumeLookup,
	resolveCounted,
	rethrowAbort,
	SpfAbort,
	type SpfBudget,
} from './spfBudget.js';

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

const MAX_SPF_MX_HOSTS = 10;
const SPF_OVERALL_TIMEOUT_MS = 20_000;

/**
 * RFC 7208 §4.5: recognize an SPF record. `v=spf1` EXACTLY is a valid
 * mechanism-less record; `v=spf1 …` carries terms. Matching the token (not a
 * space-suffixed `'v=spf1 '` prefix) means a bare `v=spf1` is no longer
 * mis-read as "no record".
 */
function isSpfRecord(record: string): boolean {
	return record === 'v=spf1' || record.startsWith('v=spf1 ');
}

/**
 * Select the single SPF record from a domain's TXT set. RFC 7208 §4.5: MORE
 * THAN ONE `v=spf1` record is a permerror — `multiple` signals that so the
 * caller returns permerror instead of silently taking the first record.
 */
function selectSpfRecord(records: readonly string[]): { record?: string; multiple: boolean } {
	const matches = records.filter(isSpfRecord);
	if (matches.length > 1) return { multiple: true };
	return { record: matches[0], multiple: false };
}

/** RFC 7208 §3.3: concatenate the character-strings within each TXT RR. */
function joinTxtRecords(records: readonly (readonly string[])[]): string[] {
	return records.map((chunks) => chunks.join(''));
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
	ehloHostname: string,
	resolver: SpfDnsResolver = defaultResolver
): Promise<SpfResult> {
	const nullSender = mailFrom === '' || mailFrom === '<>';
	const domain =
		emailDomain(mailFrom) ||
		(nullSender ? ehloHostname.trim().toLowerCase().replace(/\.$/, '') : '');
	if (!domain) {
		return { result: 'none', explanation: 'No SPF identity domain' };
	}
	const macroContext: SpfMacroContext = {
		sender: nullSender ? `postmaster@${domain}` : mailFrom,
		helo: ehloHostname,
	};

	try {
		const records = (await resolver(domain, 'TXT')) as string[][];
		const { record: spfRecord, multiple } = selectSpfRecord(joinTxtRecords(records));

		if (multiple) {
			// RFC 7208 §4.5: more than one v=spf1 record → permerror.
			return { result: 'permerror', explanation: 'Multiple SPF records published' };
		}
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
				evaluateSpf(spfRecord, senderIp, domain, budget, resolver, macroContext).catch(
					(err: unknown): SpfResult => {
						// A void-lookup-cap breach unwinds the recursion as an SpfAbort.
						if (err instanceof SpfAbort) return err.result;
						if (err instanceof SpfMacroError) {
							return { result: 'permerror', explanation: err.message };
						}
						throw err;
					}
				),
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
	resolver: SpfDnsResolver,
	macroContext: SpfMacroContext
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
		const lowerMech = mech.toLowerCase();

		// ip4:
		if (lowerMech.startsWith('ip4:')) {
			const cidr = mech.slice(4);
			if (!isValidIpv4Cidr(cidr)) {
				return { result: 'permerror', explanation: `Invalid SPF ip4 mechanism: ${cidr}` };
			}
			if (ipMatchesCidr(normalizedIp, cidr)) {
				return { result: qualifierResult };
			}
			continue;
		}

		// ip6: — RFC 7208 §5.6, with prefix-length (CIDR) support.
		if (lowerMech.startsWith('ip6:')) {
			const ip6 = mech.slice(4);
			if (!isValidIpv6Cidr(ip6)) {
				return { result: 'permerror', explanation: `Invalid SPF ip6 mechanism: ${ip6}` };
			}
			if (ipv6MatchesCidr(normalizedIp, ip6)) {
				return { result: qualifierResult };
			}
			continue;
		}

		// ptr mechanism (RFC 7208 §5.5). Implementations MUST recognize it, but its
		// use is deprecated (SHOULD NOT). We do not perform the reverse-DNS +
		// forward-confirmation lookup, so we treat it as a NON-MATCH and continue to
		// the next mechanism — never as an unknown-mechanism permerror, which would
		// discard the whole (otherwise valid) record and fail a `ptr ~all` sender.
		// One DNS lookup is still consumed so the §4.6.4 lookup budget stays aligned
		// with a resolver that would have performed the PTR query.
		if (lowerMech === 'ptr' || lowerMech.startsWith('ptr:')) {
			if (!consumeLookup(budget)) {
				return { result: 'permerror', explanation: 'SPF DNS lookup limit exceeded' };
			}
			continue;
		}

		const addressMechanism = parseAddressMechanism(mech);
		if (addressMechanism === null) {
			return { result: 'permerror', explanation: `Invalid SPF address mechanism: ${mech}` };
		}

		// a mechanism (check the domain's sender-address-family records)
		if (addressMechanism?.kind === 'a') {
			// RFC 7208 §5.3/§7: the a: domain-spec may contain macros (`a:%{d}`).
			const targetDomain = expandMacros(
				addressMechanism.domainSpec ?? domain,
				normalizedIp,
				domain,
				macroContext
			);
			if (!consumeLookup(budget)) {
				return { result: 'permerror', explanation: 'SPF DNS lookup limit exceeded' };
			}
			try {
				const addressType = senderAddressType(normalizedIp);
				const addresses = await resolveCounted<string>(targetDomain, addressType, budget, resolver);
				const prefix = normalizedIp.includes(':')
					? addressMechanism.ipv6Cidr
					: addressMechanism.ipv4Cidr;
				if (addresses.some((address) => addressMatchesSender(normalizedIp, address, prefix))) {
					return { result: qualifierResult };
				}
			} catch (err: unknown) {
				rethrowAbort(err);
				return dnsTemperror('a', targetDomain, err);
			}
			continue;
		}

		// mx mechanism (check each MX host's sender-address-family records)
		if (addressMechanism?.kind === 'mx') {
			// RFC 7208 §5.4/§7: the mx: domain-spec may contain macros (`mx:%{d}`).
			const targetDomain = expandMacros(
				addressMechanism.domainSpec ?? domain,
				normalizedIp,
				domain,
				macroContext
			);
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
						const addressType = senderAddressType(normalizedIp);
						const addresses = await resolveCounted<string>(mxHost, addressType, budget, resolver);
						const prefix = normalizedIp.includes(':')
							? addressMechanism.ipv6Cidr
							: addressMechanism.ipv4Cidr;
						if (addresses.some((address) => addressMatchesSender(normalizedIp, address, prefix))) {
							return { result: qualifierResult };
						}
					} catch (err: unknown) {
						rethrowAbort(err);
						const mxHost = typeof mx === 'string' ? mx : mx.exchange;
						return dnsTemperror('mx address', mxHost, err);
					}
				}
			} catch (err: unknown) {
				rethrowAbort(err);
				return dnsTemperror('mx', targetDomain, err);
			}
			continue;
		}

		// include: (recursive SPF lookup, one level deep)
		if (lowerMech.startsWith('include:')) {
			const includeDomain = expandMacros(mech.slice(8), normalizedIp, domain, macroContext);
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
			const { record: includeSpf, multiple: includeMultiple } = selectSpfRecord(
				joinTxtRecords(includeRecords)
			);
			// §4.5: more than one v=spf1 record at the included domain → permerror.
			if (includeMultiple) {
				return {
					result: 'permerror',
					explanation: `Included domain ${includeDomain} has multiple SPF records`,
				};
			}
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
				resolver,
				macroContext
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
		if (lowerMech.startsWith('exists:')) {
			const target = expandMacros(mech.slice(7), normalizedIp, domain, macroContext);
			if (!consumeLookup(budget)) {
				return { result: 'permerror', explanation: 'SPF DNS lookup limit exceeded' };
			}
			try {
				const aRecords = await resolveCounted<string>(target, 'A', budget, resolver);
				if (aRecords.length > 0) {
					return { result: qualifierResult };
				}
			} catch (err: unknown) {
				rethrowAbort(err);
				return dnsTemperror('exists', target, err);
			}
			continue;
		}

		// all mechanism (catch-all)
		if (lowerMech === 'all') {
			return { result: qualifierResult };
		}

		// RFC 7208 §6: an unknown or malformed mechanism is a permanent error;
		// silently skipping it can turn a broken authorization policy into `pass`.
		return { result: 'permerror', explanation: `Unknown SPF mechanism: ${mech}` };
	}

	// RFC 7208 §6.1: a redirect= modifier is only applied once all mechanisms
	// failed to match (and an `all` would already have returned above). The
	// redirected record's result IS the result — there is no qualifier and no
	// fallback to neutral on a sub-error.
	if (redirectTarget) {
		const target = expandMacros(redirectTarget, normalizedIp, domain, macroContext);
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
		const { record: redirectSpf, multiple: redirectMultiple } = selectSpfRecord(
			joinTxtRecords(redirectRecords)
		);
		// §4.5: more than one v=spf1 record at the redirect target → permerror.
		if (redirectMultiple) {
			return {
				result: 'permerror',
				explanation: `SPF redirect target ${target} has multiple SPF records`,
			};
		}
		// §6.1: a redirect to a domain with no usable SPF record is a permerror.
		if (!redirectSpf) {
			return {
				result: 'permerror',
				explanation: `SPF redirect target ${target} has no SPF record`,
			};
		}
		return evaluateSpf(redirectSpf, senderIp, target, budget, resolver, macroContext);
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
