'use node';

/**
 * DNS verifier — checks the customer-published DNS records against what the
 * provider asked for, gathers a per-provider verification verdict (when the
 * provider exposes one), and calls the **Sending domain lifecycle (module)**'s
 * `recordVerification` to land the resulting status transition.
 *
 * Per ADR-0018: the lifecycle owns the "what counts as verified" decision
 * (the reducer combines the generic DNS rule with the provider's boolean);
 * this action only collects raw data and calls the lifecycle.
 *
 * Synchronous path: the FE calls this action directly so it gets immediate
 * feedback about whether DNS passes. The action refuses while the domain is
 * still in `'registering'` — verification before register-complete makes no
 * sense.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { authedAction } from '../lib/authedFunctions';
import dns from 'node:dns/promises';
import { logError } from '../lib/runtimeLog';
import { isSendingDomainProviderKind, providerFor } from './providers';
import type { ProviderCheckResult } from './providers';
import { detectMultipleSpf, isSpfRecord, mergeSpfRecords } from './spf';
import { throwNotFound, throwInvalidState, throwInternal } from '../_utils/errors';
import { txtRecordMatches } from './dnsMatch';

type DnsRecord = {
	type?: 'TXT' | 'CNAME' | 'MX' | 'TLSA';
	host?: string;
	hostname?: string;
	value: string;
	priority?: number;
	usage?: number;
	selector?: number;
	matchingType?: number;
};

type VerificationResult = {
	verified: boolean;
	lastChecked: number;
	error?: string;
	foundValue?: string;
};

type VerificationResults = {
	spf?: VerificationResult;
	dkim?: VerificationResult[];
	dmarc?: VerificationResult;
	mailFrom?: VerificationResult[];
	tlsRpt?: VerificationResult;
	sesStatus?: string;
};

const LIFECYCLE_USER_VERIFIER = 'system:verifier';

// ─── Shared DNS lookup-error classifier ─────────────────────────────────────
//
// Each record verifier's catch tail maps a `node:dns` lookup rejection to the
// same structured `VerificationResult`: ENOTFOUND/ENODATA → "not found" (the
// only record-type-specific message), SERVFAIL → "try again later", anything
// else → the raw message. Hoisted so the three verifiers can't drift.

function classifyDnsError(
	error: unknown,
	now: number,
	notFoundMessage: string,
): VerificationResult {
	const errorMessage = error instanceof Error ? error.message : 'Unknown DNS error';
	if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('ENODATA')) {
		return { verified: false, lastChecked: now, error: notFoundMessage };
	}
	if (errorMessage.includes('SERVFAIL')) {
		return { verified: false, lastChecked: now, error: 'DNS server error - please try again later' };
	}
	return { verified: false, lastChecked: now, error: `DNS lookup failed: ${errorMessage}` };
}

// ─── DNS lookup helpers ─────────────────────────────────────────────────────

async function verifyTxtRecord(hostname: string, expectedValue: string): Promise<VerificationResult> {
	const now = Date.now();
	try {
		const records = await dns.resolveTxt(hostname);
		const txtValues = records.map((record) => record.join(''));

		// Publishing a second `v=spf1` record at a host that already has one is a
		// PermError at every receiver (RFC 7208 §3.2) — flag it as a hard
		// failure even if one of them matches the expected value, since the
		// duplicate breaks SPF evaluation entirely.
		if (expectedValue.startsWith('v=spf1') && detectMultipleSpf(txtValues)) {
			// When a foreign SPF record is present (a domain that already sends
			// through another provider), fold our mechanisms into it and offer the
			// concrete single record the operator should publish instead.
			const spfRecords = txtValues.filter((value) => isSpfRecord(value));
			const foreign = spfRecords.find((value) => value.trim() !== expectedValue.trim());
			const mergeHint = foreign
				? ` Merge them into a single record: "${mergeSpfRecords(foreign, expectedValue)}".`
				: '';
			return {
				verified: false,
				lastChecked: now,
				error:
					'Multiple v=spf1 records found at this hostname (duplicate SPF). ' +
					'Only one SPF record is allowed — merge them into a single record ' +
					`(RFC 7208 §3.2 PermError).${mergeHint}`,
				foundValue: spfRecords.join(' | '),
			};
		}

		// Match the way the relevant RFCs define record equality, not byte-for-byte:
		// nameservers normalise whitespace around the `;`-separated DKIM/DMARC tags
		// and may pad or reorder the space-separated SPF mechanisms, so a raw
		// `=== / .includes()` would falsely reject a semantically-correct record.
		// See `domains/dnsMatch.ts` (RFC 6376 §3.6.1, RFC 7489 §6.3, RFC 7208 §3.2).
		const matchingRecord = txtValues.find((value) => txtRecordMatches(value, expectedValue));
		if (matchingRecord) {
			return { verified: true, lastChecked: now, foundValue: matchingRecord };
		}

		const partialMatch = txtValues.find((value) => {
			if (expectedValue.startsWith('v=spf1') && value.startsWith('v=spf1')) return true;
			if (expectedValue.startsWith('v=DMARC1') && value.startsWith('v=DMARC1')) return true;
			return false;
		});
		if (partialMatch) {
			return {
				verified: false,
				lastChecked: now,
				foundValue: partialMatch,
				error: "Record found but value doesn't match expected configuration",
			};
		}

		return {
			verified: false,
			lastChecked: now,
			error: 'No matching TXT record found',
			foundValue: txtValues.length > 0 ? txtValues[0] : undefined,
		};
	} catch (error) {
		return classifyDnsError(error, now, 'No DNS record found at this hostname');
	}
}

async function verifyCnameRecord(hostname: string, expectedValue: string): Promise<VerificationResult> {
	const now = Date.now();
	try {
		const records = await dns.resolveCname(hostname);
		const normalizedExpected = expectedValue.toLowerCase().replace(/\.$/, '');
		const matchingRecord = records.find(
			(value) => value.toLowerCase().replace(/\.$/, '') === normalizedExpected,
		);
		if (matchingRecord) {
			return { verified: true, lastChecked: now, foundValue: matchingRecord };
		}
		return {
			verified: false,
			lastChecked: now,
			error: "CNAME record doesn't point to expected value",
			foundValue: records.length > 0 ? records[0] : undefined,
		};
	} catch (error) {
		return classifyDnsError(error, now, 'No CNAME record found at this hostname');
	}
}

async function verifyMxRecord(
	hostname: string,
	expectedValue: string,
	expectedPriority?: number,
): Promise<VerificationResult> {
	const now = Date.now();
	try {
		const records = await dns.resolveMx(hostname);
		const normalizedExpected = expectedValue.toLowerCase().replace(/\.$/, '');
		const matchingRecord = records.find((mx) => {
			const normalizedExchange = mx.exchange.toLowerCase().replace(/\.$/, '');
			const exchangeMatch = normalizedExchange === normalizedExpected;
			if (expectedPriority !== undefined) {
				return exchangeMatch && mx.priority === expectedPriority;
			}
			return exchangeMatch;
		});
		if (matchingRecord) {
			return {
				verified: true,
				lastChecked: now,
				foundValue: `${matchingRecord.priority} ${matchingRecord.exchange}`,
			};
		}
		return {
			verified: false,
			lastChecked: now,
			error: 'No matching MX record found',
			foundValue: records.length > 0 ? `${records[0]?.priority} ${records[0]?.exchange}` : undefined,
		};
	} catch (error) {
		return classifyDnsError(error, now, 'No MX record found at this hostname');
	}
}

// DANE TLSA record (RFC 6698). `@types/node`'s `dns.resolve` overloads do not
// cover the `'TLSA'` rrtype even though the runtime supports it, so the call is
// wrapped behind this narrow runtime shape. Each entry is one published
// association: `<certUsage> <selector> <match> <data:Buffer>`.
type ResolvedTlsaRecord = {
	certUsage: number;
	selector: number;
	match: number;
	data: Buffer;
};

async function resolveTlsa(hostname: string): Promise<ResolvedTlsaRecord[]> {
	const resolve = dns.resolve as unknown as (
		host: string,
		rrtype: 'TLSA',
	) => Promise<ResolvedTlsaRecord[]>;
	return resolve(hostname, 'TLSA');
}

/**
 * Parse a stored TLSA record value (`<usage> <selector> <matchingType> <hex>`)
 * into its four parts. Falls back to the explicit `usage`/`selector`/
 * `matchingType` fields when they are set. Returns `null` when the value is not
 * a well-formed TLSA payload.
 */
function parseTlsaValue(record: DnsRecord): {
	usage: number;
	selector: number;
	matchingType: number;
	data: string;
} | null {
	const parts = record.value.trim().split(/\s+/);
	if (parts.length >= 4) {
		const usage = Number(parts[0]);
		const selector = Number(parts[1]);
		const matchingType = Number(parts[2]);
		const data = parts.slice(3).join('').toLowerCase();
		if (Number.isInteger(usage) && Number.isInteger(selector) && Number.isInteger(matchingType)) {
			return { usage, selector, matchingType, data };
		}
	}
	if (
		record.usage !== undefined &&
		record.selector !== undefined &&
		record.matchingType !== undefined
	) {
		return {
			usage: record.usage,
			selector: record.selector,
			matchingType: record.matchingType,
			data: record.value.trim().replace(/\s+/g, '').toLowerCase(),
		};
	}
	return null;
}

async function verifyTlsaRecord(hostname: string, record: DnsRecord): Promise<VerificationResult> {
	const now = Date.now();
	const expected = parseTlsaValue(record);
	if (!expected) {
		return { verified: false, lastChecked: now, error: 'Invalid TLSA record configuration' };
	}
	try {
		const records = await resolveTlsa(hostname);
		const matching = records.find(
			(tlsa) =>
				tlsa.certUsage === expected.usage &&
				tlsa.selector === expected.selector &&
				tlsa.match === expected.matchingType &&
				tlsa.data.toString('hex').toLowerCase() === expected.data,
		);
		if (matching) {
			return {
				verified: true,
				lastChecked: now,
				foundValue: `${matching.certUsage} ${matching.selector} ${matching.match} ${matching.data.toString('hex')}`,
			};
		}
		return {
			verified: false,
			lastChecked: now,
			error: 'No matching TLSA record found',
			foundValue:
				records.length > 0 && records[0]
					? `${records[0].certUsage} ${records[0].selector} ${records[0].match} ${records[0].data.toString('hex')}`
					: undefined,
		};
	} catch (error) {
		return classifyDnsError(error, now, 'No TLSA record found at this hostname');
	}
}

async function runDnsLookups(
	domain: string,
	dnsRecords: {
		spf?: DnsRecord;
		dkim?: DnsRecord[];
		dmarc?: DnsRecord;
		mailFrom?: DnsRecord[];
		tlsRpt?: DnsRecord;
	},
): Promise<VerificationResults> {
	const results: VerificationResults = {};

	if (dnsRecords.spf) {
		const spfHostname = dnsRecords.spf.host === '@' ? domain : `${dnsRecords.spf.host}.${domain}`;
		results.spf = await verifyTxtRecord(spfHostname, dnsRecords.spf.value);
	}

	if (dnsRecords.dkim) {
		results.dkim = [];
		for (const dkimRecord of dnsRecords.dkim) {
			const dkimHostname = `${dkimRecord.host}.${domain}`;
			const result =
				dkimRecord.type === 'CNAME'
					? await verifyCnameRecord(dkimHostname, dkimRecord.value)
					: await verifyTxtRecord(dkimHostname, dkimRecord.value);
			results.dkim.push(result);
		}
	}

	if (dnsRecords.dmarc) {
		const dmarcHostname = `${dnsRecords.dmarc.host}.${domain}`;
		results.dmarc = await verifyTxtRecord(dmarcHostname, dnsRecords.dmarc.value);
	}

	if (dnsRecords.mailFrom && dnsRecords.mailFrom.length > 0) {
		results.mailFrom = [];
		for (const mailFromRecord of dnsRecords.mailFrom) {
			// A `hostname` is an absolute FQDN (used for the return-path SPF
			// record, which lives on RETURN_PATH_DOMAIN — a sibling of the
			// From-domain, not a subhost). Fall back to `host.domain` otherwise.
			const mailFromHostname = mailFromRecord.hostname
				? mailFromRecord.hostname
				: `${mailFromRecord.host}.${domain}`;
			if (mailFromRecord.type === 'MX') {
				results.mailFrom.push(
					await verifyMxRecord(mailFromHostname, mailFromRecord.value, mailFromRecord.priority),
				);
			} else {
				results.mailFrom.push(await verifyTxtRecord(mailFromHostname, mailFromRecord.value));
			}
		}
	}

	if (dnsRecords.tlsRpt) {
		const tlsRptHostname =
			dnsRecords.tlsRpt.host === '@' ? domain : `${dnsRecords.tlsRpt.host}.${domain}`;
		// `_smtp._tls` is a TXT record (RFC 8460 §3); a TLSA association published
		// under the same union (RFC 6698) is verified with the DANE resolver.
		results.tlsRpt =
			dnsRecords.tlsRpt.type === 'TLSA'
				? await verifyTlsaRecord(tlsRptHostname, dnsRecords.tlsRpt)
				: await verifyTxtRecord(tlsRptHostname, dnsRecords.tlsRpt.value);
	}

	return results;
}

// ─── Public verifier action ─────────────────────────────────────────────────

/**
 * Run DNS lookups + the per-provider check, then call
 * `lifecycle.recordVerification` to land the status transition. Returns the
 * synchronous result for the FE.
 */
// authz: re-runs live DNS lookups; the verdict comes from DNS, not the caller,
// and the status write goes through internal lifecycle.recordVerification.
export const verifyDomain = authedAction({
	args: {
		domainId: v.id('domains'),
	},
	handler: async (
		ctx,
		args,
	): Promise<{ success: boolean; allVerified: boolean; results: VerificationResults }> => {
		const domain = await ctx.runQuery(internal.domains.queries.getDomainForRegistration, {
			domainId: args.domainId,
		});

		if (!domain) {
			throwNotFound('Domain');
		}

		if (domain.status === 'registering') {
			throwInvalidState('Domain is still being registered. Please wait a moment and try again.');
		}

		const results = await runDnsLookups(domain.domain, domain.dnsRecords);

		// Per-provider check. SES implements `runProviderCheck`; MTA omits it
		// (treated as `{ verified: true }`).
		let providerCheck: ProviderCheckResult = { verified: true };
		if (isSendingDomainProviderKind(domain.providerType)) {
			const adapter = providerFor(domain.providerType);
			if (adapter.runProviderCheck) {
				try {
					providerCheck = await adapter.runProviderCheck(domain.domain);
					// Mirror the provider verdict into verificationResults for the
					// builder UI's per-record display (the SES status pill).
					if (domain.providerType === 'ses') {
						results.sesStatus = providerCheck.verified ? 'Success' : 'Pending';
					}
				} catch (error) {
					logError('[DNS Verification] Failed to run provider check:', error);
					providerCheck = {
						verified: false,
						lastError: error instanceof Error ? error.message : 'Unknown provider error',
					};
				}
			}
		}

		const outcome = await ctx.runMutation(internal.domains.lifecycle.recordVerification, {
			domainId: args.domainId,
			verificationResults: results,
			providerCheck,
			userId: LIFECYCLE_USER_VERIFIER,
		});

		if (!outcome.ok) {
			throwInternal(`Verification failed: ${outcome.reason}`);
		}

		return {
			success: true,
			allVerified: outcome.to === 'verified',
			results,
		};
	},
});
