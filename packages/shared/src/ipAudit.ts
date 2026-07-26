/**
 * Pre-flight sending-IP audit: the pure verdict engine.
 *
 * VPS addresses are recycled, their history is opaque, and many are already
 * listed — or sit in a /24 whose neighbours are noisy — before the operator has
 * typed a single DNS record. This module turns live observations (port-25
 * egress, DNSBL answers, FCrDNS, the /24 neighbourhood) into exactly three
 * plainly-worded outcomes so nobody invests hours in DNS for an address that
 * will never work.
 *
 * The module is deliberately pure and browser-safe: the MTA supplies the
 * observations, the operator UI and the installer render the same verdict.
 *
 * It is ADVISORY. Nothing here blocks a send, quarantines an address, or turns
 * a missing optional feed into an error state.
 */

import { DNSBL_LISTS, type DnsblListId } from './dnsbl';
import type { FcrdnsFailureReason, FcrdnsVerdict } from './fcrdns';

export const IP_AUDIT_ZONE_IDS = [
	'spamhaus',
	'barracuda',
	'spamcop',
	'sorbs',
	'invaluement',
	'abusix',
] as const;
export type IpAuditZoneId = (typeof IP_AUDIT_ZONE_IDS)[number];

export interface IpAuditZoneDefinition {
	id: IpAuditZoneId;
	name: string;
	/** Query zone; keyed feeds template the credential in at lookup time. */
	zone: string;
	/** Keyed feeds are additive-only: absent credentials lower confidence only. */
	requiresCredential: boolean;
	addressFamilies: readonly ('ipv4' | 'ipv6')[];
}

/**
 * Audit zones. The first three mirror the shipped DNSBL checker exactly (same
 * zones, same client); SORBS and Invaluement are audit-only additions that
 * never feed routing.
 */
export const IP_AUDIT_ZONES: readonly IpAuditZoneDefinition[] = [
	{
		id: 'spamhaus',
		name: DNSBL_LISTS.spamhaus.name,
		zone: 'zen.spamhaus.org',
		requiresCredential: false,
		addressFamilies: ['ipv4', 'ipv6'],
	},
	{
		id: 'barracuda',
		name: DNSBL_LISTS.barracuda.name,
		zone: 'b.barracudacentral.org',
		requiresCredential: false,
		addressFamilies: ['ipv4'],
	},
	{
		id: 'spamcop',
		name: DNSBL_LISTS.spamcop.name,
		zone: 'bl.spamcop.net',
		requiresCredential: false,
		addressFamilies: ['ipv4'],
	},
	{
		id: 'sorbs',
		name: 'SORBS',
		zone: 'dnsbl.sorbs.net',
		requiresCredential: false,
		addressFamilies: ['ipv4'],
	},
	{
		id: 'invaluement',
		name: 'Invaluement ivmSIP',
		zone: 'sip.invaluement.com',
		requiresCredential: true,
		addressFamilies: ['ipv4'],
	},
	{
		id: 'abusix',
		name: DNSBL_LISTS.abusix.name,
		zone: 'combined.mail.abusix.zone',
		requiresCredential: true,
		addressFamilies: ['ipv4', 'ipv6'],
	},
];

export function isIpAuditZoneId(value: string): value is IpAuditZoneId {
	return IP_AUDIT_ZONE_IDS.includes(value as IpAuditZoneId);
}

/** Spamhaus ZEN is several lists behind one zone; each needs different advice. */
export const SPAMHAUS_SUBLISTS = ['sbl', 'css', 'xbl', 'pbl', 'drop'] as const;
export type SpamhausSublist = (typeof SPAMHAUS_SUBLISTS)[number];

export type IpAuditZoneStatus = 'clean' | 'listed' | 'unknown' | 'skipped';

export interface IpAuditZoneObservation {
	zoneId: IpAuditZoneId;
	status: IpAuditZoneStatus;
	/** Decoded Spamhaus sub-lists; always empty for single-list zones. */
	sublists: readonly SpamhausSublist[];
	/** Bounded copy of the raw answers, for the operator's own diagnosis. */
	answers: readonly string[];
}

export type Port25EgressStatus = 'open' | 'blocked' | 'unknown';

export interface IpAuditNeighbourhood {
	/** Neighbour addresses in the same /24 that returned a definite answer. */
	sampled: number;
	/** Of those, how many are on a spam list (PBL/policy listings excluded). */
	listed: number;
}

export type NeighbourhoodStatus = 'clean' | 'mixed' | 'noisy' | 'insufficient_data';

/** Below this many definite answers a /24 sample says nothing at all. */
export const NEIGHBOURHOOD_MIN_SAMPLE = 8;
export const NEIGHBOURHOOD_NOISY_RATIO = 0.5;
export const NEIGHBOURHOOD_MIXED_RATIO = 0.2;

export function neighbourhoodStatus(neighbourhood: IpAuditNeighbourhood): NeighbourhoodStatus {
	const { sampled, listed } = neighbourhood;
	if (!Number.isFinite(sampled) || !Number.isFinite(listed)) return 'insufficient_data';
	if (sampled < NEIGHBOURHOOD_MIN_SAMPLE || sampled <= 0) return 'insufficient_data';
	const ratio = Math.max(0, Math.min(listed, sampled)) / sampled;
	if (ratio >= NEIGHBOURHOOD_NOISY_RATIO) return 'noisy';
	if (ratio >= NEIGHBOURHOOD_MIXED_RATIO) return 'mixed';
	return 'clean';
}

export const IP_AUDIT_VERDICTS = ['clean', 'action_required', 'unusable'] as const;
export type IpAuditVerdict = (typeof IP_AUDIT_VERDICTS)[number];

export type IpAuditFindingSeverity = 'blocking' | 'fixable' | 'advisory';

export const IP_AUDIT_FINDING_IDS = [
	'port25_blocked',
	'port25_unknown',
	'spamhaus_drop',
	'spamhaus_sbl',
	'spamhaus_css',
	'spamhaus_xbl',
	'spamhaus_pbl',
	'zone_listed',
	'no_ptr',
	'fcrdns_mismatch',
	'fcrdns_unknown',
	'noisy_neighbourhood',
	'mixed_neighbourhood',
	'audit_incomplete',
] as const;
export type IpAuditFindingId = (typeof IP_AUDIT_FINDING_IDS)[number];

export interface IpAuditFinding {
	id: IpAuditFindingId;
	severity: IpAuditFindingSeverity;
	zoneId?: IpAuditZoneId;
	sublist?: SpamhausSublist;
	/** One factual sentence. No lecture. */
	message: string;
	nextAction: string;
}

export interface IpAuditInput {
	ip: string;
	checkedAt: number;
	port25: Port25EgressStatus;
	zones: readonly IpAuditZoneObservation[];
	fcrdns: { verdict: FcrdnsVerdict; reason?: FcrdnsFailureReason };
	neighbourhood: IpAuditNeighbourhood;
}

export interface IpAuditReport {
	ip: string;
	checkedAt: number;
	verdict: IpAuditVerdict;
	/** Plainly-worded one-liner for the top of the screen. */
	headline: string;
	/** The single next thing to do. */
	nextAction: string;
	/** Low whenever a probe could not answer; never presented as an error. */
	confidence: 'high' | 'low';
	findings: readonly IpAuditFinding[];
	zones: readonly IpAuditZoneObservation[];
	neighbourhood: IpAuditNeighbourhood;
	neighbourhoodStatus: NeighbourhoodStatus;
	port25: Port25EgressStatus;
	fcrdns: { verdict: FcrdnsVerdict; reason?: FcrdnsFailureReason };
}

const SUBLIST_FINDINGS: Record<
	SpamhausSublist,
	{ id: IpAuditFindingId; severity: IpAuditFindingSeverity; message: string; nextAction: string }
> = {
	drop: {
		id: 'spamhaus_drop',
		severity: 'blocking',
		message: 'Spamhaus DROP covers this whole range: the network itself is not deliverable.',
		nextAction:
			'Ask your provider for an address outside this range. Delisting is not available to you.',
	},
	sbl: {
		id: 'spamhaus_sbl',
		severity: 'fixable',
		message: 'Spamhaus SBL lists this address for spam activity.',
		nextAction: 'Open the SBL removal form, state what changed, and request removal.',
	},
	css: {
		id: 'spamhaus_css',
		severity: 'fixable',
		message: 'Spamhaus CSS lists this address as a snowshoe/cold sender.',
		nextAction: 'Slow the ramp, then use the CSS self-service removal form.',
	},
	xbl: {
		id: 'spamhaus_xbl',
		severity: 'fixable',
		message: 'Spamhaus XBL lists this address as compromised, proxied, or an open relay.',
		nextAction: 'Close the open service on this host, then use the XBL self-service removal.',
	},
	pbl: {
		id: 'spamhaus_pbl',
		severity: 'fixable',
		message: 'Spamhaus PBL covers this address as a dynamic or end-user range.',
		nextAction: 'Request a PBL exclusion for this address, or ask your provider to do it.',
	},
};

function zoneName(zoneId: IpAuditZoneId): string {
	return IP_AUDIT_ZONES.find((zone) => zone.id === zoneId)?.name ?? zoneId;
}

function fcrdnsFinding(input: IpAuditInput): IpAuditFinding | undefined {
	const { verdict, reason } = input.fcrdns;
	if (verdict === 'pass' || verdict === 'warn') return undefined;
	if (verdict === 'error') {
		return {
			id: 'fcrdns_unknown',
			severity: 'fixable',
			message: 'Reverse DNS could not be checked: the resolver did not answer.',
			nextAction: 'Re-run the audit. If it keeps failing, check this host’s DNS resolver.',
		};
	}
	if (reason === 'no-ptr' || reason === 'ptr-not-fqdn') {
		return {
			id: 'no_ptr',
			severity: 'fixable',
			message: 'This address has no usable PTR record.',
			nextAction:
				'Set reverse DNS for this address to your sending hostname in your provider’s console.',
		};
	}
	return {
		id: 'fcrdns_mismatch',
		severity: 'fixable',
		message: 'Reverse DNS does not forward-confirm to this address.',
		nextAction: 'Point the PTR hostname at this address with a matching A or AAAA record.',
	};
}

function port25Finding(status: Port25EgressStatus): IpAuditFinding | undefined {
	if (status === 'open') return undefined;
	if (status === 'blocked') {
		return {
			id: 'port25_blocked',
			severity: 'blocking',
			message: 'Outbound port 25 is blocked: every probe was dropped silently.',
			nextAction:
				'Ask your provider to open outbound TCP/25 for this server, or send through a relay instead.',
		};
	}
	return {
		id: 'port25_unknown',
		severity: 'advisory',
		message: 'Outbound port 25 could not be confirmed from this address.',
		nextAction:
			'Re-run the audit once the network settles; the result is inconclusive, not a failure.',
	};
}

function neighbourhoodFinding(status: NeighbourhoodStatus): IpAuditFinding | undefined {
	if (status === 'noisy') {
		return {
			id: 'noisy_neighbourhood',
			severity: 'blocking',
			message: 'Most sampled neighbours in this /24 are blocklisted.',
			nextAction:
				'Ask your provider for an address in a different range: filters that score by /24 will punish this one.',
		};
	}
	if (status === 'mixed') {
		return {
			id: 'mixed_neighbourhood',
			severity: 'advisory',
			message: 'Some neighbours in this /24 are blocklisted.',
			nextAction: 'Usable, but ramp slowly and watch Microsoft deferrals first.',
		};
	}
	return undefined;
}

function zoneFindings(zones: readonly IpAuditZoneObservation[]): IpAuditFinding[] {
	const findings: IpAuditFinding[] = [];
	for (const zone of zones) {
		if (zone.status !== 'listed') continue;
		if (zone.zoneId === 'spamhaus') {
			for (const sublist of SPAMHAUS_SUBLISTS) {
				if (!zone.sublists.includes(sublist)) continue;
				const template = SUBLIST_FINDINGS[sublist];
				findings.push({ ...template, zoneId: 'spamhaus', sublist });
			}
			// A Spamhaus listing whose return code we could not decode still counts.
			if (zone.sublists.length === 0) {
				findings.push({
					id: 'zone_listed',
					severity: 'fixable',
					zoneId: 'spamhaus',
					message: 'Spamhaus lists this address.',
					nextAction: 'Look the address up on Spamhaus and follow the removal path it names.',
				});
			}
			continue;
		}
		findings.push({
			id: 'zone_listed',
			severity: 'fixable',
			zoneId: zone.zoneId,
			message: `${zoneName(zone.zoneId)} lists this address.`,
			nextAction: `Use the ${zoneName(zone.zoneId)} removal form after fixing the cause.`,
		});
	}
	return findings;
}

const SEVERITY_RANK: Record<IpAuditFindingSeverity, number> = {
	advisory: 0,
	fixable: 1,
	blocking: 2,
};

function headlineFor(verdict: IpAuditVerdict, findings: readonly IpAuditFinding[]): string {
	if (verdict === 'unusable') {
		return 'This address will not work for sending mail.';
	}
	if (verdict === 'action_required') {
		const count = findings.filter((finding) => finding.severity === 'fixable').length;
		return count === 1
			? 'This address can work once you fix one thing.'
			: `This address can work once you fix ${count} things.`;
	}
	return 'This address looks clean and ready to set up.';
}

/**
 * Decide the audit outcome. Pure: every input is a parameter, including the
 * clock. Unknown is never folded into clean — an unanswered probe lowers
 * confidence and, when it is a check we depend on, asks for a re-run.
 */
export function evaluateIpAudit(input: IpAuditInput): IpAuditReport {
	const neighbourStatus = neighbourhoodStatus(input.neighbourhood);
	const findings: IpAuditFinding[] = [];

	const port25 = port25Finding(input.port25);
	if (port25) findings.push(port25);
	findings.push(...zoneFindings(input.zones));
	const fcrdns = fcrdnsFinding(input);
	if (fcrdns) findings.push(fcrdns);
	const neighbour = neighbourhoodFinding(neighbourStatus);
	if (neighbour) findings.push(neighbour);

	// A zone we could not reach is not evidence of cleanliness.
	const unknownZones = input.zones.filter((zone) => zone.status === 'unknown');
	const spamhaus = input.zones.find((zone) => zone.zoneId === 'spamhaus');
	if (spamhaus?.status === 'unknown') {
		findings.push({
			id: 'audit_incomplete',
			severity: 'fixable',
			zoneId: 'spamhaus',
			message: 'Spamhaus did not answer, so this address is unverified rather than clean.',
			nextAction: 'Re-run the audit before you start sending.',
		});
	} else if (unknownZones.length > 0) {
		findings.push({
			id: 'audit_incomplete',
			severity: 'advisory',
			message: `${unknownZones.length} blocklist${unknownZones.length === 1 ? '' : 's'} did not answer.`,
			nextAction: 'Re-run the audit later; the remaining checks still stand.',
		});
	}

	findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
	const worst = findings.reduce<IpAuditFindingSeverity>(
		(acc, finding) =>
			SEVERITY_RANK[finding.severity] > SEVERITY_RANK[acc] ? finding.severity : acc,
		'advisory'
	);
	const verdict: IpAuditVerdict =
		findings.length === 0
			? 'clean'
			: worst === 'blocking'
				? 'unusable'
				: worst === 'fixable'
					? 'action_required'
					: 'clean';

	const confidence: 'high' | 'low' =
		input.port25 === 'unknown' ||
		unknownZones.length > 0 ||
		input.fcrdns.verdict === 'error' ||
		neighbourStatus === 'insufficient_data'
			? 'low'
			: 'high';

	return {
		ip: input.ip,
		checkedAt: input.checkedAt,
		verdict,
		headline: headlineFor(verdict, findings),
		nextAction:
			findings[0]?.nextAction ??
			'Continue with DNS setup: publish SPF, DKIM, and DMARC for your sending domain.',
		confidence,
		findings,
		zones: input.zones,
		neighbourhood: input.neighbourhood,
		neighbourhoodStatus: neighbourStatus,
		port25: input.port25,
		fcrdns: input.fcrdns,
	};
}

/** Spamhaus return codes. 127.255.255.x is a resolver-policy error, not a listing. */
const SPAMHAUS_CODE_SUBLISTS: Record<string, SpamhausSublist> = {
	'127.0.0.2': 'sbl',
	'127.0.0.3': 'css',
	'127.0.0.4': 'xbl',
	'127.0.0.5': 'xbl',
	'127.0.0.6': 'xbl',
	'127.0.0.7': 'xbl',
	'127.0.0.9': 'drop',
	'127.0.0.10': 'pbl',
	'127.0.0.11': 'pbl',
};

/** Decode ZEN answers into sub-lists. Unrecognised 127.x answers still count as listed. */
export function decodeSpamhausAnswers(answers: readonly string[]): SpamhausSublist[] {
	const sublists: SpamhausSublist[] = [];
	for (const answer of answers) {
		const sublist = SPAMHAUS_CODE_SUBLISTS[answer.trim()];
		if (sublist && !sublists.includes(sublist)) sublists.push(sublist);
	}
	return sublists;
}

/** The shipped DNSBL ids the audit shares with the routing checker. */
export function isSharedDnsblZone(zoneId: IpAuditZoneId): zoneId is IpAuditZoneId & DnsblListId {
	return (
		zoneId === 'spamhaus' || zoneId === 'barracuda' || zoneId === 'spamcop' || zoneId === 'abusix'
	);
}
