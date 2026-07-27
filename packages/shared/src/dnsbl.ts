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
	/**
	 * The query zone hostname. This is the SINGLE declaration of it: the routing
	 * sweep and the pre-flight IP audit both read it from here, so a zone change
	 * can never leave one of them querying the old host.
	 */
	zone: string;
	/** Keyed feeds prefix a subscriber credential onto the zone at lookup time. */
	requiresCredential: boolean;
}

export const DNSBL_LISTS: Record<DnsblListId, DnsblListDefinition> = {
	spamhaus: {
		id: 'spamhaus',
		name: 'Spamhaus',
		severity: 'critical',
		runbookPath: '/developer/dnsbl-delisting#spamhaus',
		addressFamilies: ['ipv4', 'ipv6'],
		zone: 'zen.spamhaus.org',
		requiresCredential: false,
	},
	barracuda: {
		id: 'barracuda',
		name: 'Barracuda',
		severity: 'warning',
		runbookPath: '/developer/dnsbl-delisting#barracuda',
		addressFamilies: ['ipv4'],
		zone: 'b.barracudacentral.org',
		requiresCredential: false,
	},
	spamcop: {
		id: 'spamcop',
		name: 'SpamCop',
		severity: 'warning',
		runbookPath: '/developer/dnsbl-delisting#spamcop',
		addressFamilies: ['ipv4'],
		zone: 'bl.spamcop.net',
		requiresCredential: false,
	},
	abusix: {
		id: 'abusix',
		name: 'Abusix',
		severity: 'warning',
		runbookPath: '/developer/dnsbl-delisting#abusix',
		addressFamilies: ['ipv4', 'ipv6'],
		zone: 'combined.mail.abusix.zone',
		requiresCredential: true,
	},
};

/**
 * The hostname to query for one list, or `null` when the list needs a
 * credential we do not have. A keyed feed without its key is SKIPPED, never an
 * error: every third-party feed is additive-only.
 */
export function dnsblZoneHost(
	list: DnsblListDefinition,
	credential: string | undefined
): string | null {
	if (!list.requiresCredential) return list.zone;
	return credential ? `${credential}.${list.zone}` : null;
}

export function isDnsblListId(value: string): value is DnsblListId {
	return DNSBL_LIST_IDS.includes(value as DnsblListId);
}
