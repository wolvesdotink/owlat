/**
 * Outbound-IP DNS blocklist taxonomy shared by the MTA and operator UI.
 *
 * Severity is deliberately policy, not a property inferred from a DNS answer:
 * only Spamhaus can quarantine a sending IP. The other providers are advisory
 * signals because a false positive must not starve a self-hosted pool.
 */

export const DNSBL_LIST_IDS = ['spamhaus', 'barracuda', 'spamcop', 'abusix'] as const;
export type DnsblListId = (typeof DNSBL_LIST_IDS)[number];
export type DnsblSeverity = 'critical' | 'warning';

export interface DnsblListDefinition {
	id: DnsblListId;
	name: string;
	severity: DnsblSeverity;
	runbookPath: string;
	/** Address families for which the provider documents this DNS zone. */
	addressFamilies: readonly ('ipv4' | 'ipv6')[];
}

export const DNSBL_LISTS: Record<DnsblListId, DnsblListDefinition> = {
	spamhaus: {
		id: 'spamhaus',
		name: 'Spamhaus',
		severity: 'critical',
		runbookPath: '/developer/dnsbl-delisting#spamhaus',
		addressFamilies: ['ipv4', 'ipv6'],
	},
	barracuda: {
		id: 'barracuda',
		name: 'Barracuda',
		severity: 'warning',
		runbookPath: '/developer/dnsbl-delisting#barracuda',
		addressFamilies: ['ipv4'],
	},
	spamcop: {
		id: 'spamcop',
		name: 'SpamCop',
		severity: 'warning',
		runbookPath: '/developer/dnsbl-delisting#spamcop',
		addressFamilies: ['ipv4'],
	},
	abusix: {
		id: 'abusix',
		name: 'Abusix',
		severity: 'warning',
		runbookPath: '/developer/dnsbl-delisting#abusix',
		addressFamilies: ['ipv4', 'ipv6'],
	},
};

export function isDnsblListId(value: string): value is DnsblListId {
	return DNSBL_LIST_IDS.includes(value as DnsblListId);
}
