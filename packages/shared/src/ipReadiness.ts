/** Canonical safety taxonomy for outbound-IP readiness across MTA, API, and UI. */

import { isSpfRecord, spfRecordHasExactIpMechanism } from './spf';

export const IP_READINESS_BLOCK_REASONS = [
	'dnsbl',
	'fcrdns',
	'ipv4-identity',
	'source-address',
	'spf',
] as const;
export type IpReadinessBlockReason = (typeof IP_READINESS_BLOCK_REASONS)[number];

export const DNSBL_STATUSES = ['unknown', 'clean', 'degraded', 'critical'] as const;
export type DnsblStatus = (typeof DNSBL_STATUSES)[number];

export const IPV6_SPF_VERDICTS = ['pass', 'fail', 'error'] as const;
export type Ipv6SpfVerdict = (typeof IPV6_SPF_VERDICTS)[number];

export const IPV6_SPF_FAILURE_REASONS = [
	'no-spf-record',
	'multiple-spf-records',
	'missing-ip6-mechanism',
	'lookup-error',
] as const;
export type Ipv6SpfFailureReason = (typeof IPV6_SPF_FAILURE_REASONS)[number];

export interface Ipv6SpfReadiness {
	ip: string;
	domain: string;
	verdict: Ipv6SpfVerdict;
	reason?: Ipv6SpfFailureReason;
	checkedAt: number;
}

export const SOURCE_ADDRESS_VERDICTS = ['pass', 'fail', 'error'] as const;
export type SourceAddressVerdict = (typeof SOURCE_ADDRESS_VERDICTS)[number];

export const SOURCE_ADDRESS_FAILURE_REASONS = [
	'source-ip-unavailable',
	'probe-unavailable',
] as const;
export type SourceAddressFailureReason = (typeof SOURCE_ADDRESS_FAILURE_REASONS)[number];

export function isIpReadinessBlockReason(value: string): value is IpReadinessBlockReason {
	return IP_READINESS_BLOCK_REASONS.some((reason) => reason === value);
}

export function isDnsblStatus(value: string): value is DnsblStatus {
	return DNSBL_STATUSES.some((status) => status === value);
}

export function isIpv6SpfFailureReason(value: string): value is Ipv6SpfFailureReason {
	return IPV6_SPF_FAILURE_REASONS.some((reason) => reason === value);
}

export function isSourceAddressFailureReason(value: string): value is SourceAddressFailureReason {
	return SOURCE_ADDRESS_FAILURE_REASONS.some((reason) => reason === value);
}

export function evaluateIpv6SpfRecords(
	ip: string,
	domain: string,
	records: readonly string[],
	checkedAt: number
): Ipv6SpfReadiness {
	const spfRecords = records.filter(isSpfRecord);
	if (spfRecords.length === 0) {
		return { ip, domain, verdict: 'fail', reason: 'no-spf-record', checkedAt };
	}
	if (spfRecords.length > 1) {
		return { ip, domain, verdict: 'fail', reason: 'multiple-spf-records', checkedAt };
	}
	if (!spfRecordHasExactIpMechanism(spfRecords[0]!, ip)) {
		return { ip, domain, verdict: 'fail', reason: 'missing-ip6-mechanism', checkedAt };
	}
	return { ip, domain, verdict: 'pass', checkedAt };
}

export async function observeIpv6SpfReadiness(
	ip: string,
	domain: string,
	resolveTxt: (hostname: string) => Promise<string[][]>,
	now: () => number = Date.now
): Promise<Ipv6SpfReadiness> {
	const checkedAt = now();
	try {
		const records = (await resolveTxt(domain)).map((chunks) => chunks.join(''));
		return evaluateIpv6SpfRecords(ip, domain, records, checkedAt);
	} catch (error) {
		const code = (error as { code?: string }).code;
		const missing = code === 'ENOTFOUND' || code === 'ENODATA';
		return {
			ip,
			domain,
			verdict: missing ? 'fail' : 'error',
			reason: missing ? 'no-spf-record' : 'lookup-error',
			checkedAt,
		};
	}
}
