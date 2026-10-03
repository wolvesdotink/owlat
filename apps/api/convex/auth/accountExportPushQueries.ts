import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { requireSelf } from '../lib/sessionOrganization';

// Web Push resource of "Export my data", next to accountExportQueries.ts.

/**
 * The member's Web Push devices: label and timestamps only. The endpoint and
 * the two keys are a live capability to notify this person, so they stay out
 * of a file that is meant to be downloaded and kept.
 */
export const listPersonalPushSubscriptions = internalQuery({
	args: { userId: v.string(), paginationOpts: paginationOptsValidator },
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);
		const result = await ctx.db
			.query('pushSubscriptions')
			.withIndex('by_user', (q) => q.eq('userId', args.userId))
			.paginate(args.paginationOpts);
		return {
			...result,
			page: result.page.map((row) => ({
				_id: row._id,
				label: row.label,
				timeZone: row.timeZone,
				createdAt: row.createdAt,
				lastSuccessAt: row.lastSuccessAt,
			})),
		};
	},
});
