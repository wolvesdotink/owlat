/**
 * Internal read queries on `domains` used by the **Sending domain lifecycle
 * (module)**'s effect handlers (verifier action, provider register actions).
 *
 * Per ADR-0018: extracted from the deleted `dnsVerificationQueries.ts`. The
 * status-writing mutations from that file collapsed into the lifecycle
 * reducer; only the read paths survive here.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';

/**
 * Load a domain row for the per-provider register action or the DNS
 * verifier. Caller is expected to handle the null case (logged + skip).
 */
export const getDomainForRegistration = internalQuery({
	args: {
		domainId: v.id('domains'),
	},
	handler: async (ctx, args) => {
		return await ctx.db.get(args.domainId);
	},
});

export const getSesIdentity = internalQuery({
	args: { domainId: v.id('domains') },
	handler: async (ctx, args) =>
		await ctx.db
			.query('sendingDomainSesIdentities')
			.withIndex('by_domain', (q) => q.eq('domainId', args.domainId))
			.first(),
});
