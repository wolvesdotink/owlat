import {
	fcrdnsReasonMessage,
	isFcrdnsVerdict,
	reverseDnsGuidance,
	type FcrdnsFailureReason,
} from '@owlat/shared/fcrdns';
import type { DnsblStatus, IpReadinessBlockReason } from '@owlat/shared/ipReadinessSync';
import type { HealthTone } from './healthTone';

export interface OutboundIpIdentityInput {
	active: boolean;
	blockReasons?: IpReadinessBlockReason[];
	dnsbl?: DnsblStatus;
	fcrdns?: {
		verdict: string;
		isGenericPtr: boolean;
		isOverridden: boolean;
		ptrNames: string[];
		reason?: string;
	} | null;
}

export interface OutboundIpPresentation {
	tone: HealthTone;
	label: string;
	detail: string;
	remediation: string | null;
}

export function outboundIpPresentation(ip: OutboundIpIdentityInput): OutboundIpPresentation {
	const identity = ip.fcrdns;
	const identityFailed = identity?.verdict === 'fail';
	const identityBlocked =
		ip.blockReasons?.includes('fcrdns') === true ||
		(identityFailed && identity?.isOverridden !== true);
	const dnsblBlocked = ip.blockReasons?.includes('dnsbl') === true || ip.dnsbl === 'critical';
	const dnsblUnavailable = ip.dnsbl === 'unknown';
	const dnsblDegraded = ip.dnsbl === 'degraded';
	let tone: HealthTone;
	let label: string;
	if (identityBlocked && dnsblBlocked) {
		tone = 'error';
		label = 'Identity + blocklist';
	} else if (dnsblBlocked) {
		tone = 'error';
		label = ip.dnsbl === 'unknown' ? 'Blocklist check unavailable' : 'Blocklisted';
	} else if (identityBlocked) {
		tone = 'error';
		label = 'Identity quarantined';
	} else if (identity?.isOverridden) {
		tone = 'warning';
		label = 'Lab override';
	} else if (!ip.active) {
		tone = 'error';
		label = 'Unavailable';
	} else if (!identity || !isFcrdnsVerdict(identity.verdict) || identity.verdict === 'error') {
		tone = 'error';
		label = 'Not verified';
	} else if (dnsblUnavailable) {
		tone = 'error';
		label = 'Blocklist check unavailable';
	} else if (dnsblDegraded) {
		tone = 'warning';
		label = 'Blocklist warning';
	} else if (identity.verdict === 'warn') {
		tone = 'warning';
		label = 'Needs attention';
	} else {
		tone = 'success';
		label = 'Ready';
	}

	const identityDetail = !identity
		? 'Waiting for the first live reverse-DNS check.'
		: identity.isGenericPtr
			? 'Forward DNS is valid, but this provider-default PTR can hurt sending reputation.'
			: fcrdnsReasonMessage(identity.reason as FcrdnsFailureReason | undefined);
	const blocklistDetail =
		ip.dnsbl === 'unknown'
			? 'The latest DNS blocklist lookup failed, so the prior safety decision is preserved.'
			: ip.dnsbl === 'degraded'
				? 'A non-critical DNS blocklist currently lists this IP.'
				: 'A critical DNS blocklist currently excludes this IP from delivery.';
	const hasBlocklistConcern = dnsblBlocked || dnsblUnavailable || dnsblDegraded;
	const detail =
		identityBlocked && dnsblBlocked
			? `${identityDetail} ${blocklistDetail}`
			: hasBlocklistConcern
				? blocklistDetail
				: identityDetail;
	const remediation =
		identityBlocked && identity
			? reverseDnsGuidance(identity.ptrNames).instruction
			: hasBlocklistConcern
				? 'Review the MTA blocklist details, resolve the listing cause, and request delisting.'
				: null;

	return { tone, label, detail, remediation };
}
