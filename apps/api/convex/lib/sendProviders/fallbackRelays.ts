/**
 * WHICH relays the deliverability fallback is currently configured to use —
 * read from the stored routes, in one place.
 *
 * A sibling question to `delivery/relayConfiguration.ts`'s
 * {@link configuredRelayKinds}, and deliberately not a section of it: that
 * module answers "which transports are the SECOND ARM" (every enabled non-MTA
 * entry plus the single-transport env), which is the alignment/ramp reading.
 * This one answers "which relay would an OPEN BREAKER hand traffic to", i.e.
 * `deliverabilityFallback.relayProviderType` on the routes that have the
 * fallback switched on — a strictly narrower set, and the only one the
 * relay-identity provisioning paths care about.
 *
 * Two callers, both provisioning relay identities on our own MTA's domains:
 * the forward path (`domains/lifecycle.ts`, on a domain reaching `verified`)
 * and the catch-up drain (`providerRoutes.provisionDeliverabilityRelayBatch`,
 * when an operator switches the fallback on). They used to each open the same
 * `providerRoutes` scan inline; two readings of one configuration is how the
 * two halves of "every domain gets an identity exactly once" start disagreeing
 * about which relay that identity is FOR.
 */

import type { MutationCtx, QueryCtx } from '../../_generated/server';

/**
 * Upper bound on the route rows scanned. `providerRoutes` holds one row per
 * message type (campaign, transactional, automation), so three is the real
 * ceiling; the spare row means a malformed duplicate still cannot turn a
 * verified-domain transition into an unbounded scan.
 */
const PROVIDER_ROUTE_SCAN_LIMIT = 4;

/**
 * Every relay kind named by an ENABLED deliverability fallback, deduplicated.
 *
 * Returns raw strings, not a narrowed union: a route persisted before a kind
 * was retired (or written by a newer deployment) can name anything, and the
 * caller's own registry guard is what decides whether the kind is dispatchable.
 * Empty means no route has the fallback switched on — nothing to provision.
 */
export async function enabledFallbackRelayKinds(
	ctx: QueryCtx | MutationCtx
): Promise<readonly string[]> {
	const routes = await ctx.db.query('providerRoutes').take(PROVIDER_ROUTE_SCAN_LIMIT);
	const kinds = new Set<string>();
	for (const route of routes) {
		const fallback = route.deliverabilityFallback;
		if (fallback?.isEnabled && typeof fallback.relayProviderType === 'string') {
			kinds.add(fallback.relayProviderType);
		}
	}
	return [...kinds];
}
