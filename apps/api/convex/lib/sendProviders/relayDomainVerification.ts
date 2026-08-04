/**
 * Relay-domain verification (read seam).
 *
 * "May we hand this From domain to the configured relay?" — the DNS/identity
 * proof half of the deliverability fallback, extracted from `route.ts` so
 * both the full per-message resolver and the health-free cell seam call one
 * implementation. Every read here is an indexed point read: the seam runs
 * inside enqueue transactions.
 */

import type { MutationCtx, QueryCtx } from '../../_generated/server';
import { SES_RELAY_PROOF_MAX_AGE_MS } from '@owlat/shared';

/**
 * True iff `domainName` carries a fresh, complete verification proof for the
 * configured relay provider. Only SES relays are verifiable today; anything
 * else is unverified by construction.
 */
export async function relayDomainVerified(
	ctx: QueryCtx | MutationCtx,
	domainName: string,
	relayProviderType: string,
	now: number
): Promise<boolean> {
	if (relayProviderType !== 'ses') return false;
	const domain = await ctx.db
		.query('domains')
		.withIndex('by_domain', (q) => q.eq('domain', domainName.toLowerCase()))
		.first();
	if (!domain) return false;
	const identity = await ctx.db
		.query('sendingDomainSesIdentities')
		.withIndex('by_domain', (q) => q.eq('domainId', domain._id))
		.first();
	if (
		!identity?.dnsRecords ||
		!identity.verificationResults ||
		!identity.isProviderVerified ||
		!identity.verifiedAt ||
		now - identity.verifiedAt > SES_RELAY_PROOF_MAX_AGE_MS
	)
		return false;
	const proof = identity.verificationResults;
	const spfProofState =
		identity.spfProofState ??
		(identity.dnsRecords.spf ? 'dns_required' : 'not_applicable_manual_primary');
	const spfSatisfied =
		spfProofState === 'dns_required'
			? Boolean(identity.dnsRecords.spf && proof.spf?.verified)
			: domain.providerType === 'mta' &&
				domain.status === 'verified' &&
				!identity.dnsRecords.spf &&
				!proof.spf;
	const results = [
		...(spfProofState === 'dns_required' ? [proof.spf] : []),
		...(proof.dkim ?? []),
		...(proof.mailFrom ?? []),
	];
	return Boolean(
		spfSatisfied &&
		identity.dkimTokens.length > 0 &&
		proof.dkim?.length === identity.dkimTokens.length &&
		proof.dkim.every((result) => result.verified) &&
		identity.dnsRecords.mailFrom?.length &&
		proof.mailFrom?.length === identity.dnsRecords.mailFrom.length &&
		proof.mailFrom.every((result) => result.verified) &&
		results.every((result) => {
			if (!result || !Number.isFinite(result.lastChecked)) return false;
			const age = now - result.lastChecked;
			return age >= 0 && age <= SES_RELAY_PROOF_MAX_AGE_MS;
		})
	);
}
