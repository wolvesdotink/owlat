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
 * The open pixel's and the click redirect's one commit: spend one token and,
 * inside the budget, record the open or click. Every request spends a token.
 *
 * A request for an existing Send spends that Send's `emailTrackingSend` token,
 * so one recipient's opens, clicks and the automated fetches of their mail
 * never spend another recipient's budget, whatever address they come from.
 * Every other request (no event, an id that is malformed, of another table or
 * of no row) spends the caller's `emailTracking` token and records nothing.
 * The Send is looked up before its bucket is touched, so invented ids cannot
 * create a rate-limit row each. The id arrives as a string for that reason.
 */
export const recordTrackingHit = internalMutation({
	args: {
		clientIp: v.string(),
		event: v.optional(
			v.object({ emailSendId: v.string(), transition: trackedTransitionValidator })
		),
	},
	handler: async (ctx, args): Promise<{ recorded: boolean }> => {
		const id = args.event ? ctx.db.normalizeId('emailSends', args.event.emailSendId) : null;
		const send = id === null ? null : await ctx.db.get(id);
		if (!args.event || send === null) {
			await rateLimiter.limit(ctx, 'emailTracking', { key: args.clientIp });
			return { recorded: false };
		}
		const { ok } = await rateLimiter.limit(ctx, 'emailTrackingSend', { key: send._id });
		if (!ok) return { recorded: false };
		const outcome = await applySendTransition(
			ctx,
			{ kind: 'campaign', id: send._id },
			args.event.transition
		);
		return { recorded: outcome.ok };
	},
});
