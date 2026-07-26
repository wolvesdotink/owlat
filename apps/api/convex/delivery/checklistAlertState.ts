import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';

export const getPending = internalQuery({
	args: { organizationId: v.string(), identity: v.string() },
	handler: async (ctx, args) => {
		const alert = await ctx.db
			.query('deliverabilityRegressionAlerts')
			.withIndex('by_org_identity', (q) =>
				q.eq('organizationId', args.organizationId).eq('identity', args.identity)
			)
			.unique();
		return alert?.emailNotificationState === 'pending' ? alert : null;
	},
});

export const markEmailState = internalMutation({
	args: {
		organizationId: v.string(),
		identity: v.string(),
		state: v.union(v.literal('sent'), v.literal('unavailable')),
		now: v.number(),
	},
	handler: async (ctx, args) => {
		const alert = await ctx.db
			.query('deliverabilityRegressionAlerts')
			.withIndex('by_org_identity', (q) =>
				q.eq('organizationId', args.organizationId).eq('identity', args.identity)
			)
			.unique();
		if (!alert || alert.emailNotificationState !== 'pending') return false;
		await ctx.db.patch(alert._id, {
			emailNotificationState: args.state,
			...(args.state === 'sent' ? { emailNotifiedAt: args.now } : {}),
		});
		return true;
	},
});
