/**
 * The ONE read of the shipped MX-learned destination-provider classifier.
 *
 * `destinationProviderDomains` holds observations learned from real MX
 * lookups; each row expires. The classification rule is: an unexpired learned
 * observation wins, otherwise the conservative static fallback in
 * `@owlat/shared/deliverabilityRouting`. That rule was written out twice —
 * once in the route resolver's deliverability input and once in the send
 * assignment writer — which is exactly the drift plan decision D6 forbids
 * ("adopt the shipped classifier, do not re-implement it"). Both now call
 * this.
 *
 * Domains are normalized (trimmed + lowercased) before the point read:
 * observations are stored lowercase, so `A@Gmail.com` would otherwise miss a
 * learned row that `a@gmail.com` hits, and a batch mixing the two casings
 * would issue two reads for one domain.
 */

import type { MutationCtx, QueryCtx } from '../../_generated/server';
import {
	destinationProviderForDomain,
	type DestinationProviderKey,
} from '@owlat/shared/deliverabilityRouting';

/** Canonical form of a recipient domain for classifier lookups. */
export function normalizeDestinationDomain(domain: string): string {
	return domain.trim().toLowerCase();
}

/**
 * Classify one recipient domain for one organization. A single indexed point
 * read; never a scan, never a throw.
 */
export async function resolveDestinationProvider(
	ctx: Pick<QueryCtx | MutationCtx, 'db'>,
	organizationId: string,
	domain: string,
	now: number
): Promise<DestinationProviderKey> {
	const normalized = normalizeDestinationDomain(domain);
	const learned = await ctx.db
		.query('destinationProviderDomains')
		.withIndex('by_org_domain', (q) =>
			q.eq('organizationId', organizationId).eq('domain', normalized)
		)
		.first();
	return learned && learned.expiresAt >= now
		? learned.destinationProvider
		: destinationProviderForDomain(normalized);
}
