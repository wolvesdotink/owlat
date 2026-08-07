/**
 * Relay-domain verification (read seam).
 *
 * "May we hand this From domain to the configured relay?" — the DNS/identity
 * proof half of the deliverability fallback, extracted from `route.ts` so
 * both the full per-message resolver and the health-free cell seam call one
 * implementation. Every read here is an indexed point read: the seam runs
 * inside enqueue transactions.
 *
 * Mandrill plan D6/D7 (= the seams plan's P0.3; that plan's own D6/D7 are the
 * webhook registry and the mta-protocol package, so the numbers here are
 * qualified rather than left ambiguous): the answer comes from the
 * SENDING-DOMAIN PROVIDER REGISTRY, not from
 * an identity check. This module used to open with `relayProviderType !== 'ses'
 * → false` and then inline SES's proof, which made "verifiable" mean "is SES";
 * the proof now lives with the provider that owns it
 * (`domains/providers/<kind>/`) and this file only routes the question.
 */

import type { MutationCtx, QueryCtx } from '../../_generated/server';
import { relayIdentityProviderFor } from '../../domains/providers';

/**
 * True iff `domainName` carries a fresh, complete verification proof for the
 * configured relay provider.
 *
 * Fails closed on the one thing it can be asked: a relay kind with no registered
 * relay-identity provider is UNVERIFIABLE — the honest posture for a transport
 * with no identity API (`smtp`, `resend`), for our own MTA (never a fallback
 * relay), and for a retired kind a stored route still names. It is not an error:
 * an unverifiable relay simply never gets handed the domain, and the routing gate
 * turns that into an actionable `DeliverabilityRouteError`.
 *
 * THE REGISTRY IS THE COMPOSED ONE (the seams plan's P3.2), so a bundled plugin
 * transport that contributed a `domainIdentity` answers here exactly as `ses` and
 * `mandrill` do — same call, same fail-closed default, no branch on tier. This
 * file has named no provider since P0.3 and it still names none.
 */
export async function relayDomainVerified(
	ctx: QueryCtx | MutationCtx,
	domainName: string,
	relayProviderType: string,
	now: number
): Promise<boolean> {
	const provider = relayIdentityProviderFor(relayProviderType);
	if (!provider) return false;
	return await provider.relayDomainVerified(ctx, domainName, now);
}
