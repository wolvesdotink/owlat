/**
 * WHEN THE RELAY-IDENTITY PANEL HAS ANYTHING TRUE TO SAY.
 *
 * `providerRoutes.listDeliverabilityRelayDomains` answers for every OWNED
 * sending domain, not for every domain with a relay identity: a domain with no
 * row in the identity table comes back as `provisioning` because that is what
 * the state means WHEN a relay escape hatch is configured. On a deployment that
 * has never configured one, the same shape reads as "SES status: provisioning —
 * refresh shortly to see the DNS plan" for a provisioning run that will never
 * happen, on a screen headed with a provider the deployment does not use.
 *
 * So the panel asks two questions, and either one is enough:
 *
 *  1. IS THERE REAL IDENTITY STATE? A row that carries DNS records, or whose
 *     status could only have come from an identity row, is state an operator
 *     published and must be able to see — including after they disabled the
 *     fallback again.
 *  2. COULD THERE BE? A configured escape-hatch relay OF THE KIND THIS PANEL
 *     ANSWERS FOR, whose catalog entry declares `domainVerification: 'api'`, is
 *     a provider that verifies domains through an identity API — so "publish
 *     these records before fallback can activate" is the right instruction even
 *     before the first row exists. The capability is what makes the sentence
 *     true (the seams plan's D5 asks the declaration, never "is it called ses");
 *     the kind is what makes it true OF THIS PANEL.
 *
 * WHY QUESTION 2 IS NARROWED TO THE PANEL'S OWN KIND, when D5 says a screen must
 * not ask which provider it is looking at. Because the READ has not been
 * generalised yet, and a gate cannot be more general than the data behind it:
 * `listDeliverabilityRelayDomains` reads the frozen `sendingDomainSesIdentities`
 * sibling table, so it can only ever speak for SES rows. Asked of ANY configured
 * `api` relay, this gate showed the SES-worded card to a deployment whose only
 * escape hatch is Mandrill — a second `api` kind, with its own panel already
 * rendering its own rows beside it — telling it to wait for an SES provisioning
 * run that will never start. That is the exact bug the gate exists to remove,
 * one kind over. So the caller passes the kind its query answers for, and the
 * capability question is asked of THAT kind.
 *
 * What this still does NOT fix is the copy. Making one panel speak for any `api`
 * relay is a BACKEND change (one read over `sendingDomainRelayIdentities`, the
 * generic table the domain-provider registry writes); at that point the
 * `answersForKind` argument becomes the set of kinds that read can prove, and
 * this module's shape survives. It is recorded with that owner in
 * `scripts/provider-identity-allowlist.txt`.
 */

import {
	coreSendProviderCatalogEntry,
	domainVerificationOf,
} from '@owlat/shared/sendProviderCatalog';

/** The half of a relay-domain row this gate reads. */
export interface RelayIdentityRow {
	readonly status: string;
	readonly dnsRecords?: unknown;
}

/**
 * Statuses that can ONLY be produced by an existing identity row (the query
 * derives them from its `verifiedAt`), as opposed to the two it synthesises for
 * a domain with no identity at all.
 */
const IDENTITY_BACKED_STATUSES: readonly string[] = ['pending', 'verified', 'stale'];

function isIdentityBacked(row: RelayIdentityRow): boolean {
	return row.dnsRecords !== undefined || IDENTITY_BACKED_STATUSES.includes(row.status);
}

/**
 * Should the relay-identity panel render at all?
 *
 * @param rows the query's page of owned sending domains
 * @param configuredRelayKinds the relay kinds this org has configured as a
 *   deliverability escape hatch — enabled or not, because publishing the DNS is
 *   what an operator does BEFORE enabling it
 * @param answersForKind the kinds the panel's query can actually speak for
 *   (today: the one kind whose identity table it reads). A configured relay
 *   outside this set is another panel's business, however it verifies domains.
 */
export function relayIdentityPanelVisible(
	rows: readonly RelayIdentityRow[] | undefined,
	configuredRelayKinds: readonly string[],
	answersForKind: readonly string[]
): boolean {
	if (rows === undefined || rows.length === 0) return false;
	if (rows.some(isIdentityBacked)) return true;
	return configuredRelayKinds.some((kind) => {
		if (!answersForKind.includes(kind)) return false;
		const entry = coreSendProviderCatalogEntry(kind);
		return entry !== undefined && domainVerificationOf(entry) === 'api';
	});
}
