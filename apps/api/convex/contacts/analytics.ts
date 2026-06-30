import { v } from 'convex/values';
import { authedQuery } from '../lib/authedFunctions';
import { getCachedContactCount } from '../lib/contactCountHelpers';
import { countWithPagination } from '../lib/pagination';

// Query to get audience stats for dashboard (for HTTP API)
// Uses cached contact count for O(1) performance.
export const getAudienceStats = authedQuery({
	args: {},
	handler: async (ctx) => {
		// Try to get cached contact count first
		let totalContacts = await getCachedContactCount(ctx);

		// Fallback to pagination count if no cache
		if (totalContacts === null) {
			totalContacts = await countWithPagination(ctx.db, 'contacts', 'by_created_at', (q) =>
				q
			);
		}

		// Get topics count
		const topics = await ctx.db
			.query('topics')
			.collect();

		// Get segments count
		const segments = await ctx.db
			.query('segments')
			.collect();

		return {
			totalContacts,
			topicCount: topics.length,
			segmentCount: segments.length,
		};
	},
});

// Query to get subscriber growth over time (last 30 days, for HTTP API)
export const getSubscriberGrowth = authedQuery({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

		// Get contacts created in the last 30 days using index range
		const recentContacts = await ctx.db
			.query('contacts')
			.withIndex('by_created_at', (q) =>
				q.gte('createdAt', thirtyDaysAgo)
			)
			.collect();

		// Initialize all 30 days with 0
		const dailyGrowth: Record<string, number> = {};
		for (let i = 29; i >= 0; i--) {
			const date = new Date(now - i * 24 * 60 * 60 * 1000);
			const dateKey = date.toISOString().split('T')[0] as string;
			dailyGrowth[dateKey] = 0;
		}

		// Count contacts created on each day
		for (const contact of recentContacts) {
			const dateKey = new Date(contact.createdAt).toISOString().split('T')[0] as string;
			if (dailyGrowth[dateKey] !== undefined) {
				dailyGrowth[dateKey]++;
			}
		}

		// Convert to array format
		return Object.entries(dailyGrowth).map(([date, count]) => ({
			date,
			count,
			label: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
		}));
	},
});

// Query to get recent contacts (newly added, for HTTP API)
// Uses database-level ordering and limiting for efficiency
export const getRecent = authedQuery({
	args: {
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 5;

		// Use the createdAt index for efficient ordering and limiting
		return await ctx.db
			.query('contacts')
			.withIndex('by_created_at')
			.order('desc')
			.take(limit);
	},
});

// Query to get top topics by contact count (for HTTP API)
export const getTopTopics = authedQuery({
	args: {
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 5;

		const lists = await ctx.db
			.query('topics')
			.collect();

		// Get contact counts for each list
		const listsWithCounts = await Promise.all(
			lists.map(async (list) => {
				const memberships = await ctx.db
					.query('contactTopics')
					.withIndex('by_topic', (q) => q.eq('topicId', list._id))
					.collect();
				return {
					...list,
					contactCount: memberships.length,
				};
			})
		);

		// Sort by contact count descending and take limit
		listsWithCounts.sort((a, b) => b.contactCount - a.contactCount);
		return listsWithCounts.slice(0, limit);
	},
});
