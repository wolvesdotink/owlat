import { summarizeDomainReadiness } from '~/utils/domainReadiness';

/** DMARC enforcement policy. */
export type DmarcPolicy = 'none' | 'quarantine' | 'reject';

// Status badge styling
export function getStatusBadgeClass(status: string): string {
	switch (status) {
		case 'verified':
			return 'bg-success/20 text-success border-success/30';
		case 'failed':
			return 'bg-error/20 text-error border-error/30';
		case 'registering':
			return 'bg-info/20 text-info border-info/30';
		default:
			return 'bg-warning/20 text-warning border-warning/30';
	}
}

// Status icons
const statusIcons: Record<string, string> = {
	verified: 'lucide:check-circle-2',
	failed: 'lucide:x-circle',
	pending: 'lucide:clock',
	registering: 'lucide:loader-2',
};

export function getStatusIcon(status: string): string {
	return statusIcons[status] || statusIcons['pending']!;
}

export type DnsRecord = {
	type?: 'TXT' | 'CNAME' | 'MX' | 'TLSA';
	host?: string;
	hostname?: string;
	value: string;
	priority?: number;
	usage?: number;
	selector?: number;
	matchingType?: number;
};

export type DnsRecordPanelRecord = {
	type: 'TXT' | 'CNAME' | 'MX' | 'TLSA';
	host: string;
	value: string;
	/**
	 * True when `host` is a fully-qualified absolute name rather than a name
	 * relative to the sending domain. Only the return-path record carries an
	 * absolute `hostname` (see the MTA provider: `hostname: returnPathDomain`);
	 * every other record uses a relative `host`. Threading this through preserves
	 * the host-vs-hostname distinction the panel needs to place a record in its
	 * zone, instead of re-guessing it from the string's shape.
	 */
	hostIsFqdn: boolean;
};

export type DomainDnsRecords = {
	spf?: DnsRecord;
	dkim?: DnsRecord[];
	dmarc?: DnsRecord;
	mailFrom?: DnsRecord[];
	tlsRpt?: DnsRecord;
};

export function normalizeDnsRecord(
	record: DnsRecord | null | undefined,
	fallbackType: DnsRecordPanelRecord['type']
): DnsRecordPanelRecord | null {
	if (!record?.value) return null;

	// The resolved host came from the absolute `hostname` field only when there is
	// no relative `host` (mirrors the `host ?? hostname ?? '@'` precedence below).
	const hostIsFqdn = record.host == null && record.hostname != null;

	return {
		type: record.type ?? fallbackType,
		host: record.host ?? record.hostname ?? '@',
		value: record.value,
		hostIsFqdn,
	};
}

export function hasDnsRecords(
	dnsRecords: DomainDnsRecords | null | undefined
): dnsRecords is DomainDnsRecords {
	if (!dnsRecords) return false;
	return Boolean(
		dnsRecords.spf || dnsRecords.dkim?.length || dnsRecords.dmarc || dnsRecords.mailFrom?.length
	);
}

// One-line readiness summary for the expanded DNS panel — pure composition of
// the verification data already on the domain (no extra query / lookup).
export type DomainWithVerification = {
	dnsRecords?: DomainDnsRecords | null;
	verificationResults?: Parameters<typeof summarizeDomainReadiness>[0];
};

export function readinessSummary(domain: DomainWithVerification) {
	return summarizeDomainReadiness(domain.verificationResults, domain.dnsRecords);
}
