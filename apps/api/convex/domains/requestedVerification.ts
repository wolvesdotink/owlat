'use node';

/**
 * A check of one sending domain requested over the API
 * (`publicApi/domainCheckHttp.ts`): the same check as the dashboard's Verify,
 * run in the background so a slow resolver cannot hold the HTTP request past
 * its time budget. The caller reads the result from `GET /api/v1/domains`.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { logWarn } from '../lib/runtimeLog';
import { checkSendingDomain } from './dnsVerification';

export const verifyRequested = internalAction({
	args: { domainId: v.id('domains') },
	handler: async (ctx, args): Promise<null> => {
		const domain = await ctx.runQuery(internal.domains.queries.getDomainForRegistration, {
			domainId: args.domainId,
		});
		// Removed since it was requested, or regenerated and waiting on the
		// provider: there is nothing published to check.
		if (!domain || domain.status === 'registering') return null;
		const { outcome } = await checkSendingDomain(ctx, domain);
		if (!outcome.ok) logWarn(`Requested domain check did not land: ${outcome.reason}`);
		return null;
	},
});
