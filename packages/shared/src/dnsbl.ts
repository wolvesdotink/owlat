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
	/**
	 * A keyed alternative to `zone` that an optional credential unlocks. Spamhaus
	 * answers its public mirrors only for queriers it can attribute, so shared
	 * resolvers and hosting ranges with generic reverse DNS get a refusal; its
	 * Data Query Service answers the same data under `<key>.<keyedZone>` from
	 * anywhere.
	 */
	keyedZone?: string;
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
		keyedZone: 'zen.dq.spamhaus.net',
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
 * error: every third-party feed is additive-only. `credential` is THIS list's
 * credential — a list with an optional keyed zone must never be handed another
 * provider's key.
 */
export function dnsblZoneHost(
	list: DnsblListDefinition,
	credential: string | undefined
): string | null {
	if (list.keyedZone) return credential ? `${credential}.${list.keyedZone}` : list.zone;
	if (!list.requiresCredential) return list.zone;
	return credential ? `${credential}.${list.zone}` : null;
}

/**
 * A Spamhaus DQS key is a single DNS label of letters and digits. Anything else
 * would change the shape of the queried hostname, so it is refused before it is
 * ever stored or queried.
 */
export function isSpamhausDqsKey(value: string): boolean {
	return /^[a-zA-Z0-9]{16,64}$/.test(value);
}

/**
 * Why a blocklist check concluded `unknown`. Each reason has a different fix, so
 * the operator is told which one applies rather than a generic "lookup failed":
 *
 *   * `resolver_refused` — the list answered with its reserved refusal code
 *     (127.255.255.254/.252): the query came through a shared resolver, or from
 *     an address it cannot attribute.
 *   * `rate_limited` — the reserved "too many queries" code (127.255.255.255).
 *   * `resolver_unreachable` — no answer at all: timeout, SERVFAIL, REFUSED.
 *   * `unusable_answer` — an answer outside 127/8, i.e. a resolver rewriting
 *     NXDOMAIN into something else.
 *   * `key_rejected` — the Spamhaus DQS test entry did not answer as listed, so
 *     the configured key is wrong, expired, or disabled.
 */
export const DNSBL_UNKNOWN_REASONS = [
	'resolver_refused',
	'rate_limited',
	'resolver_unreachable',
	'unusable_answer',
	'key_rejected',
] as const;
export type DnsblUnknownReason = (typeof DNSBL_UNKNOWN_REASONS)[number];

export function isDnsblUnknownReason(value: unknown): value is DnsblUnknownReason {
	return DNSBL_UNKNOWN_REASONS.some((reason) => reason === value);
}

export function isDnsblListId(value: string): value is DnsblListId {
	return DNSBL_LIST_IDS.includes(value as DnsblListId);
}
