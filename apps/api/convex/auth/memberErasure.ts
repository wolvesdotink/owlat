/**
 * Compatibility entry point for member erasure hops scheduled before erasures
 * were persisted.
 *
 * The erasure now lives in `auth/erasure/` (a `memberErasureJobs` row driven by
 * `auth/erasure/walker.ts`). Deployed code scheduled this function with the
 * subject and cursors in its arguments; a hop still queued when the new code
 * ships lands here and hands its subject to the persisted erasure, which
 * restarts from the first phase (every phase is idempotent). The cursor
 * arguments are accepted and ignored. Remove after one release.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { beginMemberErasure } from './erasure/lifecycle';

export const eraseMemberData = internalMutation({
	args: {
		authUserId: v.string(),
		requestId: v.id('accountDeletionRequests'),
		alertCursor: v.optional(v.string()),
		isAlertErasureDone: v.optional(v.boolean()),
		alertReceiptCursor: v.optional(v.string()),
		isAlertReceiptErasureDone: v.optional(v.boolean()),
		chatCursor: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const request = await ctx.db.get(args.requestId);
		if (!request) return;
		await beginMemberErasure(ctx, args.requestId, {
			authUserId: args.authUserId,
			email: request.email,
		});
	},
});
