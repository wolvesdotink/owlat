import { v } from 'convex/values';
import { authedQuery } from '../lib/authedFunctions';
import { getCachedContactCount } from '../lib/contactCountHelpers';
import { countWithPagination } from '../lib/pagination';
import { topicListing } from '../topics/listing';

// Upper bound on the reactive subscriber-growth scan. A live unbounded collect
// of every contact created in the last 30 days throws once the set exceeds the
// Convex per-query document-read limit (~32k rows); `.take(SCAN_CAP + 1)` keeps
// the read bounded and lets us flag truncation instead of crashing the whole
// audience dashboard.
const GROWTH_SCAN_CAP = 30000;

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
			.collect(); // bounded: org topics (org-scale config)

		// Get segments count
		const segments = await ctx.db
			.query('segments')
			.collect(); // bounded: org segments (org-scale config)

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

		// Get contacts created in the last 30 days using index range. Read the
		// most-recent contacts first and cap the scan: this is a live, reactive
		// subscription and an unbounded collect throws once the 30-day
		// intake exceeds the Convex per-query read limit. Because we take newest
		// first, the recent days always stay complete; if the cap is hit the
		// oldest days in the window undercount and `truncated` flags it. Past
		// this scale a per-day new-contact roll-up counter would be warranted.
		const scanned = await ctx.db
			.query('contacts')
			.withIndex('by_created_at', (q) =>
				q.gte('createdAt', thirtyDaysAgo)
			)
			.order('desc')
			.take(GROWTH_SCAN_CAP + 1);
		const truncated = scanned.length > GROWTH_SCAN_CAP;
		const recentContacts = truncated ? scanned.slice(0, GROWTH_SCAN_CAP) : scanned;

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
		const days = Object.entries(dailyGrowth).map(([date, count]) => ({
			date,
			count,
			label: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
		}));

		// `truncated` is true when the 30-day intake exceeded the scan cap, so
		// the oldest daily buckets undercount; callers can surface that.
		return { days, truncated };
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
			.collect(); // bounded: org topics (org-scale config)

		// Reuse the shared topic listing enrichment for the contact count so
		// this dashboard path and the entity's list/get cannot drift. It reads
		// the denormalized `topic.cachedMemberCount` in O(1) and only falls back
		// to a bounded `countWithPagination` on `by_topic` when the cache is
		// absent — never the old unbounded collect of every membership,
		// which threw once a topic passed ~32k members.
		const listsWithCounts = await Promise.all(
			lists.map(async (list) => {
				const { contactCount } = await topicListing.enrich!(ctx.db, list);
				return {
					...list,
					contactCount,
				};
			})
		);

		// Sort by contact count descending and take limit
		listsWithCounts.sort((a, b) => b.contactCount - a.contactCount);
		return listsWithCounts.slice(0, limit);
	},
});
