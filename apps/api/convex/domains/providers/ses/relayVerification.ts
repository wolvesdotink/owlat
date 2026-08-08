/**
 * SES relay-domain verification — the SES provider's answer to "may we hand
 * this From domain to the relay?".
 *
 * Lifted verbatim out of `lib/sendProviders/relayDomainVerification.ts`, which
 * used to hard-code `relayProviderType !== 'ses' → false` and then inline this
 * proof. It now dispatches through the sending-domain provider registry (D6/D7)
 * and this module is SES's registered implementation, so a new relay ships its
 * own proof instead of editing the seam.
 *
 * Its own file rather than a method body in `./index.ts`: everything else in
 * that adapter is a provider API call made from a `'use node'` action, while
 * this is a pair of indexed point reads made from inside an enqueue
 * transaction — different runtime, different discipline.
 */

import type { MutationCtx, QueryCtx } from '../../../_generated/server';
import { SES_RELAY_PROOF_MAX_AGE_MS } from '@owlat/shared';

/**
 * True iff `domainName` carries a fresh, complete SES verification proof:
 * a registered identity, provider-side verification, DKIM tokens all proven,
 * the custom MAIL FROM records all proven, the SPF contract satisfied (either
 * the published record verifies, or the operator's manual-primary MTA policy
 * makes it not applicable), and every DNS observation still inside
 * {@link SES_RELAY_PROOF_MAX_AGE_MS}.
 */
export async function sesRelayDomainVerified(
	ctx: QueryCtx | MutationCtx,
	domainName: string,
	now: number
): Promise<boolean> {
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
