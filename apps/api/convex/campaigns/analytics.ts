import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { authedQuery } from '../lib/authedFunctions';

// Query to get active campaigns (scheduled, sending) for dashboard (for HTTP API)
export const getActiveByOrganization = authedQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const limit = args.limit ?? 5;

		// Get scheduled campaigns (bounded to limit to avoid loading all)
		const scheduledCampaigns = await ctx.db
			.query('campaigns')
			.withIndex('by_status_and_scheduled_at', (q) => q.eq('status', 'scheduled'))
			.take(limit);

		// Get sending campaigns (bounded to limit to avoid loading all)
		const sendingCampaigns = await ctx.db
			.query('campaigns')
			.withIndex('by_status', (q) => q.eq('status', 'sending'))
			.take(limit);

		// Combine and sort by scheduledAt or sentAt
		const activeCampaigns = [...scheduledCampaigns, ...sendingCampaigns]
			.sort((a, b) => {
				const timeA = a.scheduledAt || a.sentAt || a.updatedAt;
				const timeB = b.scheduledAt || b.sentAt || b.updatedAt;
				return timeA - timeB; // Earliest first
			})
			.slice(0, limit);

		return activeCampaigns;
	},
});

// Query to get top performing sent campaigns by open rate (for HTTP API)
export const getTopPerformingByOrganization = authedQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const limit = args.limit ?? 5;

		// Get sent campaigns (bounded to prevent unbounded memory usage)
		const sentCampaigns = await ctx.db
			.query('campaigns')
			.withIndex('by_status_sent_at', (q) => q.eq('status', 'sent'))
			.order('desc')
			.take(1000);

		// Calculate open rates and sort
		const campaignsWithRates = sentCampaigns
			.map((campaign) => {
				const delivered = campaign.statsDelivered || 0;
				const opened = campaign.statsOpened || 0;
				const openRate = delivered > 0 ? (opened / delivered) * 100 : 0;
				return { ...campaign, openRate };
			})
			.filter((c) => c.statsDelivered && c.statsDelivered > 0) // Only include campaigns with deliveries
			.sort((a, b) => b.openRate - a.openRate)
			.slice(0, limit);

		return campaignsWithRates;
	},
});

// Query to get send volume for the last 7 days (for HTTP API)
export const getSendVolumeByDayByOrganization = authedQuery({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

		// Get sent campaigns in the last 7 days using composite index — the
		// index range bounds the read to one week of sent campaigns.
		const sentCampaigns = await ctx.db
			.query('campaigns')
			.withIndex('by_status_sent_at', (q) => q.eq('status', 'sent').gte('sentAt', sevenDaysAgo))
			.collect(); // bounded: 7-day index range

		// Group by day
		const volumeByDay: Record<string, number> = {};

		// Initialize all 7 days with 0
		for (let i = 6; i >= 0; i--) {
			const date = new Date(now - i * 24 * 60 * 60 * 1000);
			const dateKey = date.toISOString().split('T')[0] as string;
			volumeByDay[dateKey] = 0;
		}

		// Count emails sent per day
		for (const campaign of sentCampaigns) {
			if (campaign.sentAt) {
				const date = new Date(campaign.sentAt);
				const dateKey = date.toISOString().split('T')[0] as string;
				const currentCount = volumeByDay[dateKey];
				if (currentCount !== undefined) {
					volumeByDay[dateKey] = currentCount + (campaign.statsSent || 0);
				}
			}
		}

		// Convert to array format for chart
		return Object.entries(volumeByDay).map(([date, count]) => ({
			date,
			count,
			label: new Date(date).toLocaleDateString('en-US', {
				month: 'short',
				day: 'numeric',
			}),
		}));
	},
});

// Query to get recently sent campaigns (for HTTP API)
// Note: Uses status index then sorts by sentAt. For large datasets,
// consider adding a by_status_sent_at index.
export const getRecentlySentByOrganization = authedQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const limit = args.limit ?? 5;

		// Use by_status_sent_at index to get campaigns already sorted by sentAt,
		// ordered descending so we can take(limit) directly without loading all.
		const sentCampaigns = await ctx.db
			.query('campaigns')
			.withIndex('by_status_sent_at', (q) => q.eq('status', 'sent'))
			.order('desc')
			.take(limit);

		return sentCampaigns;
	},
});

/** Safety cap on the comparable-send window (index-ordered take, no scan). */
const COMPARABLE_SENDS_LIMIT = 100;

// Recent sent campaigns as lightweight comparison snapshots — powers the
// "delta vs previous comparable send" line under each report hero tile. Returns
// only the aggregated `stats*` counts + `isABTest`/`sentAt` needed to pick the
// prior comparable send and diff its rates; the report page runs the pure
// selection (`selectPreviousComparable`) and delta math client-side so the
// choice is unit-testable without Convex. Bounded by the index-ordered take, so
// no `emailSends` are read here.
// all-members: aggregated campaign send stats, same member-visible surface as getRecentlySentByOrganization
export const getComparableSentCampaigns = authedQuery({
	args: {},
	handler: async (ctx) => {
		const sentCampaigns = await ctx.db
			.query('campaigns')
			.withIndex('by_status_sent_at', (q) => q.eq('status', 'sent'))
			.order('desc')
			.take(COMPARABLE_SENDS_LIMIT);

		return sentCampaigns
			.filter((c): c is Doc<'campaigns'> & { sentAt: number } => c.sentAt !== undefined)
			.map((c) => ({
				id: c._id,
				name: c.name,
				sentAt: c.sentAt,
				isABTest: c.isABTest ?? false,
				sent: c.statsSent ?? 0,
				delivered: c.statsDelivered ?? 0,
				opened: c.statsOpened ?? 0,
				clicked: c.statsClicked ?? 0,
				bounced: c.statsBounced ?? 0,
			}));
	},
});
