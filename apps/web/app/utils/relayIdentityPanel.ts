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
 *  2. COULD THERE BE? A configured escape-hatch relay whose catalog entry
 *     declares `domainVerification: 'api'` is a provider that verifies domains
 *     through an identity API, so "publish these records before fallback can
 *     activate" is the right instruction even before the first row exists. This
 *     is the capability question the seams plan's D5 asks of this screen —
 *     never "is the relay called ses".
 *
 * What this does NOT fix is the copy: the query reads the frozen SES sibling
 * table directly, so the panel can only speak for that one relay's rows. Making
 * it speak for any `api` relay is a BACKEND change (one read over
 * `sendingDomainRelayIdentities`, the generic table the domain-provider registry
 * writes) and is recorded as such in `scripts/provider-identity-allowlist.txt`.
 * Until then this gate is what keeps the panel off screens it cannot answer for.
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
 */
export function relayIdentityPanelVisible(
	rows: readonly RelayIdentityRow[] | undefined,
	configuredRelayKinds: readonly string[]
): boolean {
	if (rows === undefined || rows.length === 0) return false;
	if (rows.some(isIdentityBacked)) return true;
	return configuredRelayKinds.some((kind) => {
		const entry = coreSendProviderCatalogEntry(kind);
		return entry !== undefined && domainVerificationOf(entry) === 'api';
	});
}
