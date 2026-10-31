import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { rateLimiter } from '../lib/rateLimiter';
import { applySendTransition } from './sendLifecycle';
import { openAgentValidator } from './automatedOpens';
import { clickAgentValidator } from './automatedClicks';

// Open/click tracking writes go through `delivery/sendLifecycle`:
// trackingHttp.ts records them with `recordTrackingHit` below. This file also
// keeps a read-only Send lookup used by `trackClick` to validate the redirect
// target before recording. URL helpers live in `sendComposition/trackingUrl.ts`.

// Internal query to get email send by ID (for tracking)
export const getEmailSendForTracking = internalQuery({
	args: { emailSendId: v.id('emailSends') },
	handler: async (ctx, args) => {
		const send = await ctx.db.get(args.emailSendId);
		if (!send) return null;

		return {
			_id: send._id,
			campaignId: send.campaignId,
			contactId: send.contactId,
			status: send.status,
		};
	},
});

const trackedTransitionValidator = v.union(
	v.object({ to: v.literal('opened'), at: v.number(), agent: v.optional(openAgentValidator) }),
	v.object({
		to: v.literal('clicked'),
		at: v.number(),
		url: v.string(),
		agent: v.optional(clickAgentValidator),
	})
);

/**
 * The open pixel's and the click redirect's one commit: spend the caller's
 * `emailTracking` token and, inside the budget, record the open or click.
 * Every request spends a token, including one with no event to record. The id
 * arrives as a string because a well-formed id of another table still spends
 * its token; it then records nothing.
 */
export const recordTrackingHit = internalMutation({
	args: {
		clientIp: v.string(),
		event: v.optional(
			v.object({ emailSendId: v.string(), transition: trackedTransitionValidator })
		),
	},
	handler: async (ctx, args): Promise<{ recorded: boolean }> => {
		const { ok } = await rateLimiter.limit(ctx, 'emailTracking', { key: args.clientIp });
		if (!ok || !args.event) return { recorded: false };
		const id = ctx.db.normalizeId('emailSends', args.event.emailSendId);
		if (id === null) return { recorded: false };
		const outcome = await applySendTransition(ctx, { kind: 'campaign', id }, args.event.transition);
		return { recorded: outcome.ok };
	},
});
