import { getWarmingDisplayCapForDay, GRADUATED_DISPLAY_CAP } from './warming';
import {
	isFcrdnsFailureReason,
	isFcrdnsVerdict,
	type FcrdnsFailureReason,
	type FcrdnsVerdict,
} from './fcrdns';
import { isDnsblListId, type DnsblListId } from './dnsbl';
import {
	IP_READINESS_BLOCK_REASONS,
	DNSBL_STATUSES,
	isDnsblStatus,
	isIpReadinessBlockReason,
	isIpv6SpfFailureReason,
	isSourceAddressFailureReason,
	type DnsblStatus,
	type IpReadinessBlockReason,
	type Ipv6SpfFailureReason,
	type Ipv6SpfVerdict,
	type SourceAddressFailureReason,
	type SourceAddressVerdict,
} from './ipReadiness';

export { IP_READINESS_BLOCK_REASONS, isIpReadinessBlockReason };
export type { IpReadinessBlockReason };
export { DNSBL_STATUSES, isDnsblStatus };
export type { DnsblStatus };

export interface MtaIpReputationPayload {
	date: string;
	ips: Array<{
		ip: string;
		sent: number;
		bounced: number;
		deferred: number;
		warmingPhase: string;
		warmingDay: number;
		pool: string;
		active: boolean;
		blockReasons?: IpReadinessBlockReason[];
		dnsbl?: DnsblStatus;
		dnsblListings?: DnsblListId[];
		fcrdns?: {
			ehlo: string;
			ptrNames: string[];
			checklist: {
				ptrExists: boolean;
				ptrIsFqdn: boolean;
				forwardConfirmed: boolean;
				ehloMatches: boolean;
			};
			verdict: FcrdnsVerdict;
			genericPtr: boolean;
			reason?: FcrdnsFailureReason;
			checkedAt: number;
			overridden: boolean;
		} | null;
		ipv6Spf?: {
			domain: string;
			verdict: Ipv6SpfVerdict;
			reason?: Ipv6SpfFailureReason;
			checkedAt: number;
		} | null;
		sourceAddress?: {
			verdict: SourceAddressVerdict;
			reason?: SourceAddressFailureReason;
			target?: string;
			checkedAt: number;
		} | null;
	}>;
}

type MtaIpReputationRow = MtaIpReputationPayload['ips'][number];
type MtaFcrdnsPayload = NonNullable<MtaIpReputationRow['fcrdns']>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isBlockReasonArray(value: unknown): value is IpReadinessBlockReason[] {
	return isStringArray(value) && value.every(isIpReadinessBlockReason);
}

function isDnsblListingArray(value: unknown): value is DnsblListId[] {
	return isStringArray(value) && value.every(isDnsblListId);
}

function isFcrdnsPayload(value: unknown): value is MtaFcrdnsPayload {
	if (!isRecord(value) || !isRecord(value['checklist'])) return false;
	const checklist = value['checklist'];
	return (
		typeof value['ehlo'] === 'string' &&
		isStringArray(value['ptrNames']) &&
		typeof checklist['ptrExists'] === 'boolean' &&
		typeof checklist['ptrIsFqdn'] === 'boolean' &&
		typeof checklist['forwardConfirmed'] === 'boolean' &&
		typeof checklist['ehloMatches'] === 'boolean' &&
		typeof value['verdict'] === 'string' &&
		isFcrdnsVerdict(value['verdict']) &&
		typeof value['genericPtr'] === 'boolean' &&
		(value['reason'] === undefined ||
			(typeof value['reason'] === 'string' && isFcrdnsFailureReason(value['reason']))) &&
		typeof value['checkedAt'] === 'number' &&
		Number.isFinite(value['checkedAt']) &&
		typeof value['overridden'] === 'boolean'
	);
}

function isIpv6SpfPayload(value: unknown): value is NonNullable<MtaIpReputationRow['ipv6Spf']> {
	return (
		isRecord(value) &&
		typeof value['domain'] === 'string' &&
		(value['verdict'] === 'pass' || value['verdict'] === 'fail' || value['verdict'] === 'error') &&
		(value['reason'] === undefined ||
			(typeof value['reason'] === 'string' && isIpv6SpfFailureReason(value['reason']))) &&
		typeof value['checkedAt'] === 'number' &&
		Number.isFinite(value['checkedAt'])
	);
}

function isSourceAddressPayload(
	value: unknown
): value is NonNullable<MtaIpReputationRow['sourceAddress']> {
	return (
		isRecord(value) &&
		(value['verdict'] === 'pass' || value['verdict'] === 'fail' || value['verdict'] === 'error') &&
		(value['reason'] === undefined ||
			(typeof value['reason'] === 'string' && isSourceAddressFailureReason(value['reason']))) &&
		(value['target'] === undefined || typeof value['target'] === 'string') &&
		typeof value['checkedAt'] === 'number' &&
		Number.isFinite(value['checkedAt'])
	);
}

function isIpReputationRow(value: unknown): value is MtaIpReputationRow {
	return (
		isRecord(value) &&
		typeof value['ip'] === 'string' &&
		typeof value['sent'] === 'number' &&
		Number.isFinite(value['sent']) &&
		typeof value['bounced'] === 'number' &&
		Number.isFinite(value['bounced']) &&
		typeof value['deferred'] === 'number' &&
		Number.isFinite(value['deferred']) &&
		typeof value['warmingPhase'] === 'string' &&
		typeof value['warmingDay'] === 'number' &&
		Number.isFinite(value['warmingDay']) &&
		typeof value['pool'] === 'string' &&
		typeof value['active'] === 'boolean' &&
		(value['blockReasons'] === undefined || isBlockReasonArray(value['blockReasons'])) &&
		(value['dnsbl'] === undefined ||
			(typeof value['dnsbl'] === 'string' && isDnsblStatus(value['dnsbl']))) &&
		(value['dnsblListings'] === undefined || isDnsblListingArray(value['dnsblListings'])) &&
		(value['fcrdns'] === undefined ||
			value['fcrdns'] === null ||
			isFcrdnsPayload(value['fcrdns'])) &&
		(value['ipv6Spf'] === undefined ||
			value['ipv6Spf'] === null ||
			isIpv6SpfPayload(value['ipv6Spf'])) &&
		(value['sourceAddress'] === undefined ||
			value['sourceAddress'] === null ||
			isSourceAddressPayload(value['sourceAddress']))
	);
}

/** Normalize rolling-upgrade MTA payloads into the optional Convex DTO shape. */
export function normalizeIpReputationPayload(value: unknown) {
	if (
		!isRecord(value) ||
		typeof value['date'] !== 'string' ||
		!Array.isArray(value['ips']) ||
		!value['ips'].every(isIpReputationRow)
	)
		return null;
	const sourceIps = value['ips'];
	const campaignIps = sourceIps.filter((ip) => ip.pool === 'campaign');
	let totalDailyCap = campaignIps.length === 0 ? 999999 : 0;
	let totalSentToday = 0;
	let anyRamp = false;
	let anyPlateau = false;

	const ips = sourceIps.map((ip) => {
		const dailyCap =
			ip.warmingPhase === 'graduated'
				? GRADUATED_DISPLAY_CAP
				: getWarmingDisplayCapForDay(ip.warmingDay);
		if (ip.pool === 'campaign') {
			totalDailyCap += dailyCap;
			totalSentToday += ip.sent;
			if (ip.warmingPhase === 'ramp') anyRamp = true;
			if (ip.warmingPhase === 'plateau') anyPlateau = true;
		}
		const bounceRate = ip.sent > 0 ? ip.bounced / ip.sent : 0;
		const deferralRate = ip.sent > 0 ? ip.deferred / ip.sent : 0;
		return {
			ip: ip.ip,
			phase: ip.warmingPhase || 'unknown',
			currentDay: ip.warmingDay,
			dailyCap,
			sentToday: ip.sent,
			bounceRate: Math.round(bounceRate * 10000) / 10000,
			deferralRate: Math.round(deferralRate * 10000) / 10000,
			pool: ip.pool,
			active: ip.active,
			...(Array.isArray(ip.blockReasons) ? { blockReasons: ip.blockReasons } : {}),
			...(typeof ip.dnsbl === 'string' ? { dnsbl: ip.dnsbl } : {}),
			...(Array.isArray(ip.dnsblListings) ? { dnsblListings: ip.dnsblListings } : {}),
			...(ip.fcrdns
				? {
						fcrdns: {
							ehlo: ip.fcrdns.ehlo,
							ptrNames: ip.fcrdns.ptrNames,
							isPtrPresent: ip.fcrdns.checklist.ptrExists,
							isPtrFqdn: ip.fcrdns.checklist.ptrIsFqdn,
							isForwardConfirmed: ip.fcrdns.checklist.forwardConfirmed,
							isEhloMatched: ip.fcrdns.checklist.ehloMatches,
							verdict: ip.fcrdns.verdict,
							isGenericPtr: ip.fcrdns.genericPtr,
							...(ip.fcrdns.reason ? { reason: ip.fcrdns.reason } : {}),
							checkedAt: ip.fcrdns.checkedAt,
							isOverridden: ip.fcrdns.overridden,
						},
					}
				: {}),
			...(ip.ipv6Spf
				? {
						ipv6Spf: {
							domain: ip.ipv6Spf.domain,
							verdict: ip.ipv6Spf.verdict,
							...(ip.ipv6Spf.reason ? { reason: ip.ipv6Spf.reason } : {}),
							checkedAt: ip.ipv6Spf.checkedAt,
						},
					}
				: {}),
			...(ip.sourceAddress
				? {
						sourceAddress: {
							verdict: ip.sourceAddress.verdict,
							...(ip.sourceAddress.reason ? { reason: ip.sourceAddress.reason } : {}),
							...(ip.sourceAddress.target ? { target: ip.sourceAddress.target } : {}),
							checkedAt: ip.sourceAddress.checkedAt,
						},
					}
				: {}),
		};
	});

	return {
		phase: anyPlateau ? 'plateau' : anyRamp ? 'ramp' : 'graduated',
		totalDailyCap,
		totalSentToday,
		ipCount: sourceIps.length,
		ips,
	};
}
