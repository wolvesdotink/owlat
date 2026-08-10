'use node';

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { runDnsLookups } from './dnsVerification';
import { isOwnPrimarySendingDomain, providerFor } from './providers';

/**
 * Refresh the independent DNS and provider proof for an SES relay identity
 * COEXISTING on a sending domain whose primary provider is our own MTA.
 *
 * The gate below is D3's sanctioned own-vs-not-own identity, read from the
 * domain-provider registry's single declaration; it used to be
 * `providerType === 'ses'` — the relay's name standing in for the rule. Same
 * rows either way: an SES sibling with DNS records is written only by the
 * ordinary lifecycle (SES-primary domains, refused by both spellings) and by
 * the relay provisioning pair, which provisions own-MTA-primary domains and
 * nothing else (`lib/sendProviders/fallbackRelays.ts`).
 *
 * `isOwnPrimarySendingDomain` rather than a bare comparison for the reason that
 * predicate states: `providerType` is optional in the schema and the old
 * spelling admitted the legacy row that never recorded one. Its caller
 * (`domains/dnsVerification.ts`) applies the same predicate before scheduling
 * this action — two gates, one reading, so this one can only ever refuse MORE
 * than the caller and never a row the caller let through.
 */
export const refreshSesRelayIdentity = internalAction({
	args: { domainId: v.id('domains') },
	handler: async (ctx, args): Promise<{ refreshed: boolean; verified?: boolean }> => {
		const [domain, identity] = await Promise.all([
			ctx.runQuery(internal.domains.queries.getDomainForRegistration, args),
			ctx.runQuery(internal.domains.queries.getSesIdentity, args),
		]);
		if (!domain || !identity?.dnsRecords || !isOwnPrimarySendingDomain(domain.providerType)) {
			return { refreshed: false };
		}

		const results = await runDnsLookups(domain.domain, identity.dnsRecords);
		const sesAdapter = providerFor('ses');
		const providerCheck = await sesAdapter.runProviderCheck!(domain.domain);
		// The same projection the DNS verifier applies, asked of the same adapter:
		// how SES's verdict is spelled into `verificationResults` is stated once,
		// in `domains/providers/ses/index.ts`.
		Object.assign(results, sesAdapter.verificationStatusFields!(providerCheck));
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
