/**
 * Canonical Deliverability Center taxonomy and reducer.
 *
 * `pass` is intentionally evidence-only: configuration presence may explain a
 * failure, but only a validator observation can prove a check.
 */

export const DELIVERABILITY_CHECKLIST_STATUSES = ['pass', 'warn', 'fail', 'pending-dns'] as const;
export type DeliverabilityChecklistStatus = (typeof DELIVERABILITY_CHECKLIST_STATUSES)[number];

export const DELIVERABILITY_SEVERITIES = ['blocking', 'reputation', 'recommended'] as const;
export type DeliverabilitySeverity = (typeof DELIVERABILITY_SEVERITIES)[number];

export const DEPLOYMENT_CHECK_IDS = [
	'deployment.ptr',
	'deployment.fcrdns',
	'deployment.ptr_nongeneric',
	'deployment.ehlo_ptr',
	'deployment.port25',
	'deployment.tls',
	'deployment.dnsbl',
	'deployment.warmup',
	'deployment.relay',
	'deployment.ipv6_address',
	'deployment.ipv6_source',
	'deployment.ipv6_ptr',
	'deployment.ipv6_aaaa',
	'deployment.ipv6_spf',
	'deployment.ipv6_pool',
] as const;
export const DOMAIN_CHECK_IDS = [
	'domain.spf',
	'domain.dkim',
	'domain.dmarc',
	'domain.return_path',
	'domain.mta_sts',
	'domain.tls_rpt',
	'domain.tlsa',
	'domain.tracking',
	'domain.unsubscribe',
	'domain.postmaster',
	'domain.spam_rate',
] as const;

export type DeploymentCheckId = (typeof DEPLOYMENT_CHECK_IDS)[number];
export type DomainCheckId = (typeof DOMAIN_CHECK_IDS)[number];
export type DeliverabilityCheckId = DeploymentCheckId | DomainCheckId;
export const DELIVERABILITY_NEXT_ACTIONS: Record<DeliverabilityCheckId, string> = {
	'deployment.ptr': 'Set the sending address PTR to the exact mail hostname Owlat shows.',
	'deployment.fcrdns': 'Publish the matching A record so the PTR hostname resolves back.',
	'deployment.ptr_nongeneric': 'Replace the provider-default PTR with a dedicated mail hostname.',
	'deployment.ehlo_ptr': 'Set the MTA EHLO hostname to the verified PTR hostname.',
	'deployment.port25': 'Request outbound TCP/25 access or configure a verified relay fallback.',
	'deployment.tls': 'Install a current TLS certificate covering the SMTP hostname.',
	'deployment.dnsbl': 'Follow the named blocklist delisting runbook before sending.',
	'deployment.warmup': 'Keep eligible campaign volume within the current warm-up cap.',
	'deployment.relay': 'Configure and verify an SES fallback route for urgent mail.',
	'deployment.ipv6_address': 'Allocate one stable, publicly routed IPv6 sending address.',
	'deployment.ipv6_source': 'Bind outbound SMTP explicitly to the verified IPv6 address.',
	'deployment.ipv6_ptr': 'Set the IPv6 PTR to the same dedicated mail hostname.',
	'deployment.ipv6_aaaa': 'Publish the exact AAAA record for the IPv6 PTR hostname.',
	'deployment.ipv6_spf': 'Add the exact sending address as an SPF ip6 mechanism.',
	'deployment.ipv6_pool': 'Enable IPv6 only after every preceding IPv6 proof passes.',
	'domain.spf': 'Publish the exact SPF TXT value shown, ending in -all.',
	'domain.dkim': 'Publish every DKIM selector exactly as shown by Owlat.',
	'domain.dmarc': 'Publish the shown DMARC policy after SPF and DKIM pass.',
	'domain.return_path': 'Publish the displayed return-path MX and SPF records.',
	'domain.mta_sts': 'Publish the MTA-STS TXT id and serve the matching HTTPS policy.',
	'domain.tls_rpt': 'Publish the displayed _smtp._tls TXT reporting address.',
	'domain.tlsa': 'Publish the displayed TLSA association in the DNSSEC-signed zone.',
	'domain.tracking': 'Publish the tracking CNAME to the exact Owlat endpoint.',
	'domain.unsubscribe': 'Send marketing mail through the production one-click signing path.',
	'domain.postmaster': 'Authorize this verified domain in Google Postmaster Tools.',
	'domain.spam_rate': 'Pause risky volume and reduce complaints below the 0.10% target.',
};
export type DeliverabilityScope =
	| { kind: 'deployment' }
	| { kind: 'domain'; domainId: string; domain: string };

export interface DeliverabilityChecklistDefinition {
	id: DeliverabilityCheckId;
	title: string;
	protocol: string;
	severity: DeliverabilitySeverity;
	impact: string;
	docsHref: string;
	dependencies: readonly DeliverabilityCheckId[];
	dnsBacked: boolean;
}

function check(
	id: DeliverabilityCheckId,
	title: string,
	protocol: string,
	severity: DeliverabilitySeverity,
	impact: string,
	docsHref: string,
	dependencies: readonly DeliverabilityCheckId[] = [],
	dnsBacked = false
): DeliverabilityChecklistDefinition {
	return { id, title, protocol, severity, impact, docsHref, dependencies, dnsBacked };
}

const DOCS_ORIGIN = 'https://docs.owlat.app';
const VPS = `${DOCS_ORIGIN}/guide/sending-from-a-vps`;
const DOMAIN = `${DOCS_ORIGIN}/guide/deliverability`;
const FEEDBACK = `${DOCS_ORIGIN}/developer/external-reputation-feedback`;

export const DELIVERABILITY_CHECKLIST = [
	check(
		'deployment.ptr',
		"Prove you own your server's address",
		'Reverse DNS (PTR)',
		'blocking',
		'Without a PTR record, Gmail and other receivers can slow down or refuse your mail.',
		`${VPS}#the-outbound-ip-readiness-checklist`,
		[],
		true
	),
	check(
		'deployment.fcrdns',
		'Make the server name point back to its address',
		'Forward-confirmed reverse DNS (FCrDNS)',
		'blocking',
		'Forward confirmation proves the server name and sending address belong together.',
		`${VPS}#the-outbound-ip-readiness-checklist`,
		['deployment.ptr'],
		true
	),
	check(
		'deployment.ptr_nongeneric',
		'Give your mail server a trustworthy name',
		'Non-generic PTR',
		'reputation',
		'Provider-default hostnames are a strong low-reputation signal.',
		`${VPS}#the-outbound-ip-readiness-checklist`,
		['deployment.ptr'],
		true
	),
	check(
		'deployment.ehlo_ptr',
		'Introduce the server with the same name',
		'EHLO/PTR alignment',
		'blocking',
		'A matching SMTP greeting prevents identity errors during receiver checks.',
		`${VPS}#the-outbound-ip-readiness-checklist`,
		['deployment.fcrdns']
	),
	check(
		'deployment.port25',
		'Let the server reach recipient mailboxes',
		'Outbound SMTP port 25',
		'blocking',
		'Direct delivery cannot leave this server while outbound port 25 is blocked.',
		`${VPS}#vps-provider-comparison`,
		['deployment.fcrdns']
	),
	check(
		'deployment.tls',
		'Protect mail while it travels',
		'SMTP TLS certificate',
		'blocking',
		'Valid TLS avoids receiver throttling and protects messages in transit.',
		`${VPS}#preflight-the-server-before-setup`,
		['deployment.port25']
	),
	check(
		'deployment.dnsbl',
		'Keep the sending address off blocklists',
		'DNS blocklists',
		'blocking',
		'A listed address can be refused before authentication is evaluated.',
		`${VPS}#operate-the-ramp`,
		['deployment.fcrdns'],
		true
	),
	check(
		'deployment.warmup',
		'Build sending history gradually',
		'IP warm-up',
		'reputation',
		'A controlled ramp prevents sudden-volume throttling on a new address.',
		`${VPS}#what-warming-weeks-14-look-like`,
		['deployment.port25', 'deployment.dnsbl']
	),
	check(
		'deployment.relay',
		'Keep a safe delivery fallback',
		'Relay fallback',
		'recommended',
		'A verified relay keeps important mail moving during an IP reputation incident.',
		`${VPS}#choose-direct-relay-or-hybrid-delivery`
	),
	check(
		'deployment.ipv6_address',
		'Add an IPv6 sending address',
		'IPv6 address',
		'recommended',
		'IPv6 expands capacity only after the existing IPv4 identity is healthy.',
		`${VPS}#add-outbound-ipv6-only-after-ipv4-is-green`,
		[
			'deployment.ptr',
			'deployment.fcrdns',
			'deployment.ehlo_ptr',
			'deployment.port25',
			'deployment.dnsbl',
		]
	),
	check(
		'deployment.ipv6_source',
		'Bind the server to the IPv6 address',
		'IPv6 source binding',
		'recommended',
		'Explicit source binding ensures real mail uses the address you verified.',
		`${VPS}#add-outbound-ipv6-only-after-ipv4-is-green`,
		['deployment.ipv6_address']
	),
	check(
		'deployment.ipv6_ptr',
		'Name the IPv6 address',
		'IPv6 reverse DNS (PTR)',
		'recommended',
		'Receivers expect IPv6 senders to have the same strong identity as IPv4.',
		`${VPS}#add-outbound-ipv6-only-after-ipv4-is-green`,
		['deployment.ipv6_source'],
		true
	),
	check(
		'deployment.ipv6_aaaa',
		'Point the server name to IPv6',
		'AAAA/FCrDNS',
		'recommended',
		'The forward record must resolve exactly back to the sending IPv6 address.',
		`${VPS}#add-outbound-ipv6-only-after-ipv4-is-green`,
		['deployment.ipv6_ptr'],
		true
	),
	check(
		'deployment.ipv6_spf',
		'Authorize the exact IPv6 sender',
		'SPF ip6 mechanism',
		'recommended',
		'An exact ip6 mechanism prevents the new address from failing SPF.',
		`${VPS}#add-outbound-ipv6-only-after-ipv4-is-green`,
		['deployment.ipv6_aaaa'],
		true
	),
	check(
		'deployment.ipv6_pool',
		'Enable IPv6 for real mail',
		'IPv6 pool readiness',
		'recommended',
		'The pool stays locked until every IPv6 identity prerequisite is verified.',
		`${VPS}#add-outbound-ipv6-only-after-ipv4-is-green`,
		['deployment.ipv6_spf']
	),
	check(
		'domain.spf',
		'Tell the world who may send for your domain',
		'SPF with -all',
		'blocking',
		'SPF authorizes Owlat and rejects unauthorized senders using your domain.',
		`${DOMAIN}#required-dns-records`,
		[],
		true
	),
	check(
		'domain.dkim',
		'Sign your emails so Gmail trusts them',
		'DKIM (2048-bit or stronger)',
		'blocking',
		'DKIM proves messages were signed by your domain and were not changed.',
		`${DOMAIN}#required-dns-records`,
		[],
		true
	),
	check(
		'domain.dmarc',
		'Tell receivers how to check your From address',
		'DMARC and From alignment',
		'blocking',
		'DMARC alignment is required for bulk sending and blocks domain impersonation.',
		`${DOMAIN}#raising-your-dmarc-policy`,
		['domain.spf', 'domain.dkim'],
		true
	),
	check(
		'domain.return_path',
		'Route bounces through your domain',
		'Return-Path / VERP',
		'blocking',
		'An aligned return path makes SPF useful and lets Owlat process bounces safely.',
		`${DOMAIN}#required-dns-records`,
		['domain.spf'],
		true
	),
	check(
		'domain.mta_sts',
		'Require trusted TLS for incoming mail',
		'MTA-STS',
		'recommended',
		'A fetchable policy tells compatible senders not to downgrade encrypted delivery.',
		`${DOMAIN}#verification-flow`,
		['domain.dmarc'],
		true
	),
	check(
		'domain.tls_rpt',
		'Receive reports about TLS problems',
		'TLS-RPT',
		'recommended',
		'TLS reports reveal delivery encryption failures before users report missing mail.',
		`${DOMAIN}#verification-flow`,
		['domain.mta_sts'],
		true
	),
	check(
		'domain.tlsa',
		'Pin your receiving certificate in DNS',
		'DANE / TLSA',
		'recommended',
		'DANE adds DNSSEC-backed certificate assurance where supported.',
		`${DOMAIN}#verification-flow`,
		['domain.mta_sts'],
		true
	),
	check(
		'domain.tracking',
		'Use your own links for tracking',
		'Tracking domain',
		'recommended',
		'A verified tracking domain keeps message links aligned with your brand.',
		`${DOMAIN}#required-dns-records`,
		['domain.dmarc'],
		true
	),
	check(
		'domain.unsubscribe',
		'Let subscribers leave in one click',
		'RFC 8058 one-click unsubscribe',
		'blocking',
		'One-click unsubscribe prevents complaints and is required for bulk marketing mail.',
		`${DOMAIN}#unsubscribe-and-preferences`,
		['domain.dkim']
	),
	check(
		'domain.postmaster',
		'Connect Gmail delivery feedback',
		'Google Postmaster Tools',
		'recommended',
		'Postmaster data shows the spam rate Gmail actually observes for this domain.',
		FEEDBACK,
		['domain.dmarc']
	),
	check(
		'domain.spam_rate',
		'Keep complaints below receiver limits',
		'Spam rate (0.10% target / 0.30% limit)',
		'reputation',
		'A rising complaint rate damages both domain and IP reputation.',
		`${DOMAIN}#what-01-and-03-mean`,
		['domain.unsubscribe']
	),
] as const satisfies readonly DeliverabilityChecklistDefinition[];

export interface DeliverabilityValidatorEvidence {
	provenance: 'validator';
	validator: string;
	status: DeliverabilityChecklistStatus;
	observedAt: number;
	observedValues: readonly string[];
	diagnostic: string;
	attemptId: string;
}

export interface DeliverabilityChecklistItem extends DeliverabilityChecklistDefinition {
	scope: DeliverabilityScope;
	status: DeliverabilityChecklistStatus;
	lastCheckedAt?: number;
	observed: readonly string[];
	failureReason?: string;
	diagnosticReport: string;
}

export type DeliverabilityGrade = 'ready' | 'needs_attention' | 'at_risk';

export function materializeChecklistItem(
	definition: DeliverabilityChecklistDefinition,
	scope: DeliverabilityScope,
	evidence: DeliverabilityValidatorEvidence | null,
	fallbackStatus: Exclude<DeliverabilityChecklistStatus, 'pass'> = 'fail'
): DeliverabilityChecklistItem {
	const status = evidence?.status ?? fallbackStatus;
	if (status === 'pass' && evidence?.provenance !== 'validator') {
		throw new Error(`Checklist pass for ${definition.id} requires validator evidence`);
	}
	return {
		...definition,
		scope,
		status,
		...(evidence ? { lastCheckedAt: evidence.observedAt } : {}),
		observed: evidence?.observedValues ?? [],
		...(status === 'fail' || status === 'warn'
			? { failureReason: evidence?.diagnostic ?? 'No successful verification has been recorded.' }
			: {}),
		diagnosticReport: evidence?.diagnostic ?? 'No validator evidence has been recorded yet.',
	};
}

export function deriveDeliverabilityGrade(
	items: readonly Pick<DeliverabilityChecklistItem, 'status' | 'severity'>[]
): DeliverabilityGrade {
	if (items.some((item) => item.severity === 'blocking' && item.status === 'fail')) {
		return 'at_risk';
	}
	return items.some((item) => item.severity !== 'recommended' && item.status !== 'pass')
		? 'needs_attention'
		: 'ready';
}

export function dependenciesPass(
	item: Pick<DeliverabilityChecklistItem, 'dependencies' | 'scope'>,
	items: readonly Pick<DeliverabilityChecklistItem, 'id' | 'status' | 'scope'>[]
): boolean {
	return item.dependencies.every(
		(dependency) =>
			items.find(
				(candidate) =>
					candidate.id === dependency &&
					(candidate.scope.kind === 'deployment'
						? item.scope.kind === 'deployment'
						: item.scope.kind === 'domain' && candidate.scope.domainId === item.scope.domainId)
			)?.status === 'pass'
	);
}

export function selectNextDeliverabilityItem(
	items: readonly DeliverabilityChecklistItem[]
): DeliverabilityChecklistItem | null {
	for (const severity of DELIVERABILITY_SEVERITIES) {
		const candidate = items.find(
			(item) =>
				item.severity === severity && item.status !== 'pass' && dependenciesPass(item, items)
		);
		if (candidate) return candidate;
	}
	return null;
}
