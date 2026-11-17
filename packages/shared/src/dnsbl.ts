/**
 * DNS blocklist taxonomy (sending IPs and sending domains) shared by the MTA and operator UI.
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

/**
 * Domain blocklists: the From domain, the return-path host and the tracking
 * domain appear in every message, and a listing on one of these junks mail
 * whatever the sending IP's reputation.
 *
 * Each zone answers a querier it will not serve with a reserved code instead
 * of data, and that answer is neither a listing nor a clean result:
 *
 *   * Spamhaus DBL answers 127.255.255.254 to a public or unattributable
 *     resolver, 127.255.255.255 when the querier is over its volume, and
 *     127.255.255.252 for a malformed query. Its listings are 127.0.1.0/24
 *     (127.0.1.255 means "IP queries are not allowed here"). The Data Query
 *     Service answers the same data under `<key>.dbl.dq.spamhaus.net` from
 *     anywhere, with the operator's Spamhaus DQS key.
 *   * SURBL and URIBL answer 127.0.0.1 to every query they refuse (a public
 *     resolver or excessive volume); bit 1 is never a listing. SURBL's listing
 *     bits are every other bit of the last octet; URIBL's black list is bit 2,
 *     and its grey (bulk senders) and red (monitored) bits are not listings.
 *
 * All three are free for low-volume queries from a server's own recursive
 * resolver, which is what the MTA's `DNSBL_RESOLVER` provides.
 */
export const DOMAIN_BLOCKLIST_IDS = ['spamhaus_dbl', 'surbl', 'uribl'] as const;
export type DomainBlocklistId = (typeof DOMAIN_BLOCKLIST_IDS)[number];

export interface DomainBlocklistDefinition {
	id: DomainBlocklistId;
	name: string;
	zone: string;
	/** The keyed zone the Spamhaus DQS key unlocks, as for the IP list. */
	keyedZone?: string;
	/** Where the domain owner asks for removal. */
	delistingUrl: string;
}

export const DOMAIN_BLOCKLISTS: Record<DomainBlocklistId, DomainBlocklistDefinition> = {
	spamhaus_dbl: {
		id: 'spamhaus_dbl',
		name: 'Spamhaus DBL',
		zone: 'dbl.spamhaus.org',
		keyedZone: 'dbl.dq.spamhaus.net',
		delistingUrl: 'https://check.spamhaus.org/',
	},
	surbl: {
		id: 'surbl',
		name: 'SURBL',
		zone: 'multi.surbl.org',
		delistingUrl: 'https://surbl.org/surbl-analysis',
	},
	uribl: {
		id: 'uribl',
		name: 'URIBL',
		zone: 'multi.uribl.com',
		delistingUrl: 'https://admin.uribl.com/',
	},
};

export function isDomainBlocklistId(value: string): value is DomainBlocklistId {
	return DOMAIN_BLOCKLIST_IDS.includes(value as DomainBlocklistId);
}

export type DomainBlocklistVerdict =
	| { status: 'listed' | 'clean' }
	| { status: 'unknown'; reason: DnsblUnknownReason };

function lastOctet(answer: string, prefix: string): number | null {
	if (!answer.startsWith(prefix)) return null;
	const value = Number(answer.slice(prefix.length));
	return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
}

/**
 * Read one zone's A answers for a queried domain. An empty answer is NXDOMAIN,
 * i.e. clean. A refusal or an answer outside the zone's documented codes is
 * `unknown`, never listed and never clean.
 */
export function readDomainBlocklistAnswer(
	id: DomainBlocklistId,
	answers: readonly string[]
): DomainBlocklistVerdict {
	if (answers.length === 0) return { status: 'clean' };
	if (answers.some((answer) => answer.startsWith('127.255.255.'))) {
		return {
			status: 'unknown',
			reason: answers.includes('127.255.255.255') ? 'rate_limited' : 'resolver_refused',
		};
	}
	if (id === 'spamhaus_dbl') {
		const codes = answers.map((answer) => lastOctet(answer, '127.0.1.'));
		if (codes.some((code) => code === null || code === 255)) {
			return { status: 'unknown', reason: 'unusable_answer' };
		}
		return { status: 'listed' };
	}
	const bits = answers.map((answer) => lastOctet(answer, '127.0.0.'));
	if (bits.some((value) => value === null)) return { status: 'unknown', reason: 'unusable_answer' };
	if (bits.some((value) => value === 1)) return { status: 'unknown', reason: 'resolver_refused' };
	const listingBits = id === 'uribl' ? 0b10 : 0b1111_1110;
	return bits.some((value) => (value! & listingBits) !== 0)
		? { status: 'listed' }
		: { status: 'clean' };
}
