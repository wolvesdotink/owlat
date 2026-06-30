import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';

// Open/click tracking writes go through `delivery/sendLifecycle` —
// trackingHttp.ts calls `transition({ to: 'opened' | 'clicked', ... })`
// directly. This file keeps a read-only Send lookup used by `trackClick`
// to validate the redirect target before recording. URL helpers live in
// `sendComposition/trackingUrl.ts`.

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
