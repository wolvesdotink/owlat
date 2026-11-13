'use node';

/**
 * Scheduled re-verification of one sending domain: the same DNS lookups and
 * lifecycle path as the manual Verify, run by the daily sweep
 * (`reverificationSweep.ts`) and by the confirming check a verified domain's
 * first failure schedules. Without it a verified domain would stay verified
 * after its records were deleted, and keep sending mail that fails DMARC.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { runDnsLookups } from './dnsVerification';
import { recordVerificationPass } from './verificationPass';

export const reverifyDomain = internalAction({
	args: { domainId: v.id('domains') },
	handler: async (ctx, args): Promise<null> => {
		const domain = await ctx.runQuery(internal.domains.queries.getDomainForRegistration, {
			domainId: args.domainId,
		});
		// Removed since it was scheduled, or regenerated and waiting on the
		// provider: there is nothing published to check.
		if (!domain || domain.status === 'registering') return null;

		const results = await runDnsLookups(domain.domain, domain.dnsRecords);
		await recordVerificationPass(ctx, domain, results);
		return null;
	},
});
