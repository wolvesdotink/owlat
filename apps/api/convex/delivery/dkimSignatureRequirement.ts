/**
 * Whether a governed send through the built-in MTA is owed a DKIM signature.
 *
 * The MTA cannot tell on its own: it sees only the keys left in Redis, and a
 * key that is missing because Redis was lost looks exactly like a domain that
 * never had one. This side knows. A From domain registered with the MTA as its
 * sending-domain provider is one whose key the MTA generated and whose DKIM
 * record the operator was told to publish, so the send carries
 * `requireDkimSignature` and the MTA holds it rather than ship it unsigned.
 *
 * Any status counts, not only `verified`. Regenerating a lost key moves the
 * domain back through `registering` and `pending` while DNS still publishes
 * the old public key; mail already accepted for that domain must keep waiting
 * until the new record is live, and the MTA holds it until it sees that record
 * itself. New mail from an unverified domain is refused before it gets here.
 */

import { extractDomainOrNull } from '@owlat/shared';
import type { QueryCtx } from '../_generated/server';
import { OWN_SENDING_DOMAIN_PROVIDER_KIND } from '../domains/providers';

export async function isDkimSignatureRequired(ctx: QueryCtx, from: string): Promise<boolean> {
	const domain = extractDomainOrNull(from);
	if (!domain) return false;
	const row = await ctx.db
		.query('domains')
		.withIndex('by_domain', (q) => q.eq('domain', domain))
		.first();
	return row?.providerType === OWN_SENDING_DOMAIN_PROVIDER_KIND;
}
