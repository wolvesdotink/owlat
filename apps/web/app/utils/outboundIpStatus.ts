import { isFcrdnsVerdict, reverseDnsGuidance, type FcrdnsFailureReason } from '@owlat/shared/fcrdns';
import type { DnsblStatus, IpReadinessBlockReason } from '@owlat/shared/ipReadiness';
import type { HealthTone } from './healthTone';

/**
 * The words this module hands back are catalog KEYS — it is module scope and
 * never calls `useI18n`, so `SendingDetails.vue` is the render boundary that
 * turns them into sentences.
 *
 * WHY THE FCrDNS SENTENCES ARE KEYED HERE rather than read from
 * `@owlat/shared/fcrdns`. That package is shared with the backend (it words the
 * same verdict for the MTA's own logs and for API responses) and is not part of
 * the UI catalog, so calling `fcrdnsReasonMessage` here would paint one English
 * sentence into an otherwise translated panel. The reason → key map below is the
 * same set of verdicts with the same copy, worded from the catalog instead.
 */
const FCRDNS_REASON_KEYS: Readonly<Record<FcrdnsFailureReason, string>> = {
	'no-ptr': 'shared.outboundIpStatus.identity.noPtr',
	'ptr-not-fqdn': 'shared.outboundIpStatus.identity.notFqdn',
	'forward-mismatch': 'shared.outboundIpStatus.identity.forwardMismatch',
	'ehlo-mismatch': 'shared.outboundIpStatus.identity.ehloMismatch',
	'lookup-error': 'shared.outboundIpStatus.identity.lookupError',
};

/** The identity half of the detail line, as its catalog key. */
function fcrdnsReasonKey(reason: FcrdnsFailureReason | undefined): string {
	return (
		(reason === undefined ? undefined : FCRDNS_REASON_KEYS[reason]) ??
		'shared.outboundIpStatus.identity.ready'
	);
}

/** The last path segment of an identity key — how the combined lines are named. */
function detailVariant(identityKey: string): string {
	return identityKey.slice(identityKey.lastIndexOf('.') + 1);
}

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
	/** Catalog key for the chip label. */
	label: string;
	/** Catalog key for the one-line explanation under the chip. */
	detail: string;
	/** Catalog key for the fix-it line, or `null` when there is nothing to do. */
	remediation: string | null;
}

export function outboundIpPresentation(ip: OutboundIpIdentityInput): OutboundIpPresentation {
	const identity = ip.fcrdns;
	const identityFailed = identity?.verdict === 'fail';
	const identityBlocked =
		ip.blockReasons?.includes('fcrdns') === true ||
		(identityFailed && identity?.isOverridden !== true);
	const dnsblBlocked = ip.blockReasons?.includes('dnsbl') === true || ip.dnsbl === 'critical';
	const ipv4IdentityBlocked = ip.blockReasons?.includes('ipv4-identity') === true;
	const sourceAddressBlocked = ip.blockReasons?.includes('source-address') === true;
	const spfBlocked = ip.blockReasons?.includes('spf') === true;
	const dnsblUnavailable = ip.dnsbl === 'unknown';
	const dnsblDegraded = ip.dnsbl === 'degraded';
	let tone: HealthTone;
	let label: string;
	if (sourceAddressBlocked) {
		tone = 'error';
		label = 'shared.outboundIpStatus.label.sourceAddress';
	} else if (spfBlocked) {
		tone = 'error';
		label = 'shared.outboundIpStatus.label.spf';
	} else if (ipv4IdentityBlocked) {
		tone = 'error';
		label = 'shared.outboundIpStatus.label.ipv4';
	} else if (identityBlocked && dnsblBlocked) {
		tone = 'error';
		label = 'shared.outboundIpStatus.label.identityAndBlocklist';
	} else if (dnsblBlocked) {
		tone = 'error';
		label =
			ip.dnsbl === 'unknown'
				? 'shared.outboundIpStatus.label.blocklistUnavailable'
				: 'shared.outboundIpStatus.label.blocklisted';
	} else if (identityBlocked) {
		tone = 'error';
		label = 'shared.outboundIpStatus.label.identityQuarantined';
	} else if (identity?.isOverridden) {
		tone = 'warning';
		label = 'shared.outboundIpStatus.label.labOverride';
	} else if (!ip.active) {
		tone = 'error';
		label = 'shared.outboundIpStatus.label.unavailable';
	} else if (!identity || !isFcrdnsVerdict(identity.verdict) || identity.verdict === 'error') {
		tone = 'error';
		label = 'shared.outboundIpStatus.label.notVerified';
	} else if (dnsblUnavailable) {
		tone = 'error';
		label = 'shared.outboundIpStatus.label.blocklistUnavailable';
	} else if (dnsblDegraded) {
		tone = 'warning';
		label = 'shared.outboundIpStatus.label.blocklistWarning';
	} else if (identity.verdict === 'warn') {
		tone = 'warning';
		label = 'shared.outboundIpStatus.label.needsAttention';
	} else {
		tone = 'success';
		label = 'shared.outboundIpStatus.label.ready';
	}

	const identityDetail = !identity
		? 'shared.outboundIpStatus.identity.waiting'
		: identity.isGenericPtr
			? 'shared.outboundIpStatus.identity.genericPtr'
			: fcrdnsReasonKey(identity.reason as FcrdnsFailureReason | undefined);
	const blocklistDetail =
		ip.dnsbl === 'unknown'
			? 'shared.outboundIpStatus.blocklist.unavailable'
			: ip.dnsbl === 'degraded'
				? 'shared.outboundIpStatus.blocklist.degraded'
				: 'shared.outboundIpStatus.blocklist.critical';
	const hasBlocklistConcern = dnsblBlocked || dnsblUnavailable || dnsblDegraded;
	const detail = sourceAddressBlocked
		? 'shared.outboundIpStatus.detail.sourceAddress'
		: spfBlocked
			? 'shared.outboundIpStatus.detail.spf'
			: ipv4IdentityBlocked
				? 'shared.outboundIpStatus.detail.ipv4'
				: identityBlocked && dnsblBlocked
					? // Both halves are on screen as one line, and a line is not assembled
						// from translated fragments (their order is a per-language decision),
						// so each pairing is its own message.
						`shared.outboundIpStatus.combined.${detailVariant(identityDetail)}.${detailVariant(blocklistDetail)}`
					: hasBlocklistConcern
						? blocklistDetail
						: identityDetail;
	const remediation = sourceAddressBlocked
		? 'shared.outboundIpStatus.remediation.sourceAddress'
		: spfBlocked
			? 'shared.outboundIpStatus.remediation.spf'
			: ipv4IdentityBlocked
				? 'shared.outboundIpStatus.remediation.ipv4'
				: identityBlocked && identity
					? `shared.outboundIpStatus.remediation.${reverseDnsGuidance(identity.ptrNames).provider}`
					: hasBlocklistConcern
						? 'shared.outboundIpStatus.remediation.blocklist'
						: null;

	return { tone, label, detail, remediation };
}
