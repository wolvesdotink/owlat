import { getWarmingDisplayCapForDay, GRADUATED_DISPLAY_CAP } from './warming';

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
		blockReasons?: string[];
		dnsbl?: string;
		fcrdns?: {
			ehlo: string;
			ptrNames: string[];
			checklist: {
				ptrExists: boolean;
				ptrIsFqdn: boolean;
				forwardConfirmed: boolean;
				ehloMatches: boolean;
			};
			verdict: string;
			genericPtr: boolean;
			reason?: string;
			checkedAt: number;
			overridden: boolean;
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
		typeof value['genericPtr'] === 'boolean' &&
		(value['reason'] === undefined || typeof value['reason'] === 'string') &&
		typeof value['checkedAt'] === 'number' &&
		Number.isFinite(value['checkedAt']) &&
		typeof value['overridden'] === 'boolean'
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
		(value['blockReasons'] === undefined || isStringArray(value['blockReasons'])) &&
		(value['dnsbl'] === undefined || typeof value['dnsbl'] === 'string') &&
		(value['fcrdns'] === undefined || value['fcrdns'] === null || isFcrdnsPayload(value['fcrdns']))
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
