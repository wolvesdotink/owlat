/**
 * The Deliverability Center checklist CATALOG: the per-check definitions and
 * the English copy they carry. Split from `deliverabilityChecklist.ts` (which
 * keeps the ids, cadences, evidence reducer and grading) purely along the
 * data/logic seam — `deliverabilityChecklist.ts` re-exports everything here,
 * so importers see one module.
 */
import type { DeliverabilityCheckId, DeliverabilitySeverity } from './deliverabilityChecklist';

/**
 * Unlike `operatingModes.ts` — whose copy is catalog keys, because only the web
 * renders it — a check's `title` and `impact` are read outside the browser too:
 * `deliverabilityDiagnostics.ts` prints `Check: <title>` into the copyable
 * diagnostic dump beside the raw status codes, and Convex STORES and MAILS
 * `"<title> regressed after a confirmed pass: …"` (`delivery/checklistEvidence.ts`),
 * where there is no vue-i18n instance and the reader may not be the operator who
 * picked the locale. So these fields stay English sentences and stay the fallback.
 *
 * The web mirrors every check under `sharedPkg.deliverabilityChecklist.items.*`
 * and resolves it through `useDeliverabilityChecklistCopy()`
 * (`apps/web/app/composables/useDeliverabilityChecklistCopy.ts`).
 * `apps/web/app/__tests__/sharedRegistryCatalog.test.ts` pins the two copies of
 * the English together, so editing a sentence here without the catalog fails.
 */
export interface DeliverabilityChecklistDefinition {
	id: DeliverabilityCheckId;
	/** English name; the web renders `sharedPkg.deliverabilityChecklist.items.<id>.title`. */
	title: string;
	protocol: string;
	severity: DeliverabilitySeverity;
	/** English rationale; the web renders `…items.<id>.impact`. */
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
