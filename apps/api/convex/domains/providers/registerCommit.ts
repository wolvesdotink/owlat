/**
 * The one write of `registerAction.run` (the `'use node'` provider call lives
 * there; this is its V8 half): the registration's outcome and, for a domain
 * that registered, the return-path repair, in one transaction.
 */

import { v } from 'convex/values';
import { internalMutation } from '../../lib/writeFence';
import { logError } from '../../lib/runtimeLog';
import { transitionDomain } from '../lifecycle';
import { transitionInputValidator, type SendingDomainTransitionOutcome } from '../lifecycleReducer';
import { reconcileReturnPathAfterRegistrationIn } from '../lifecycleReturnPath';

/**
 * Land `registering → pending` (with the provider's records and identity) or
 * `registering → failed`. The lifecycle re-checks the edge against the row as
 * it is now, so a domain that moved on while the provider was asked refuses it.
 *
 * A registered domain also gets its return-path repair here, in the same
 * transaction, so a return-path edit cannot commit between the two. A repair
 * that throws (a provider misconfiguration) is logged and leaves the
 * registration standing: it builds its records before it writes anything, and
 * a registered domain must not be failed by its repair.
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
		const outcome = await transitionDomain(ctx, args.domainId, args.input, args.userId);
		if (args.input.to !== 'pending') return outcome;
		try {
			await reconcileReturnPathAfterRegistrationIn(ctx, {
				domainId: args.domainId,
				registeredReturnPathHost: args.registeredReturnPathHost,
				userId: args.userId,
			});
		} catch (error) {
			logError(`[domains] Return-path repair after registering ${args.domainId} failed:`, error);
		}
		return outcome;
	},
});
