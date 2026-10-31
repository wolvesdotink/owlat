/**
 * The one write of `registerAction.run` (the `'use node'` provider call lives
 * there; this is its V8 half): the registration's outcome and, for a domain
 * that registered, the return-path repair, in one transaction.
 */

import { v } from 'convex/values';
import { internalMutation } from '../../lib/writeFence';
import { transitionDomain } from '../lifecycle';
import {
	transitionInputValidator,
	type SendingDomainStatus,
	type SendingDomainTransitionOutcome,
} from '../lifecycleReducer';
import { reconcileReturnPathAfterRegistrationIn } from '../lifecycleReturnPath';

/**
 * Land `registering → pending` (with the provider's records and identity) or
 * `registering → failed`. Only a domain still `registering` takes the result:
 * the general graph also allows `verified → pending` and `verified → failed`,
 * so without this check a late result would downgrade a domain that moved on
 * and replace its records.
 *
 * A registered domain also gets its return-path repair here, in the same
 * transaction, so a return-path edit cannot commit between the two. The repair
 * swallows only its own record-building failure (a provider misconfiguration),
 * which happens before it writes; any later throw rolls the whole commit back.
 */
export const commitRegistration = internalMutation({
	args: {
		domainId: v.id('domains'),
		input: transitionInputValidator,
		/** The host the provider records were built for, as the action read it. */
		registeredReturnPathHost: v.optional(v.string()),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<SendingDomainTransitionOutcome> => {
		const domain = await ctx.db.get(args.domainId);
		if (!domain) return { ok: false, reason: 'domain_not_found' };
		if (domain.status !== 'registering') {
			return {
				ok: false,
				reason: 'illegal_edge',
				from: domain.status as SendingDomainStatus,
				to: args.input.to,
			};
		}
		const outcome = await transitionDomain(ctx, args.domainId, args.input, args.userId);
		if (!outcome.ok || args.input.to !== 'pending') return outcome;
		await reconcileReturnPathAfterRegistrationIn(ctx, {
			domainId: args.domainId,
			registeredReturnPathHost: args.registeredReturnPathHost,
			userId: args.userId,
		});
		return outcome;
	},
});
