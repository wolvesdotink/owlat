'use node';

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { runDnsLookups } from './dnsVerification';
import { providerFor } from './providers';

/**
 * Refresh the independent DNS and provider proof for an SES relay identity
 * attached to a primary non-SES sending domain.
 */
export const refreshSesRelayIdentity = internalAction({
	args: { domainId: v.id('domains') },
	handler: async (ctx, args): Promise<{ refreshed: boolean; verified?: boolean }> => {
		const [domain, identity] = await Promise.all([
			ctx.runQuery(internal.domains.queries.getDomainForRegistration, args),
			ctx.runQuery(internal.domains.queries.getSesIdentity, args),
		]);
		if (!domain || !identity?.dnsRecords || domain.providerType === 'ses') {
			return { refreshed: false };
		}

		const results = await runDnsLookups(domain.domain, identity.dnsRecords);
		const providerCheck = await providerFor('ses').runProviderCheck!(domain.domain);
		results.sesStatus = providerCheck.verified ? 'Success' : 'Pending';
		const outcome = await ctx.runMutation(internal.domains.sesRelayMutations.storeVerification, {
			domainId: args.domainId,
			dnsRecords: identity.dnsRecords,
			verificationResults: results,
			isProviderVerified: providerCheck.verified,
			checkedAt: Date.now(),
		});
		return { refreshed: outcome.recorded, verified: outcome.verified };
	},
});
