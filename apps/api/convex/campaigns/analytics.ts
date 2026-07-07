import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { authedQuery, authedAction } from '../lib/authedFunctions';
import { loadAbTestStats, computeAbVariantStats } from './abTest';

type AbVariantStats = ReturnType<typeof computeAbVariantStats>;
type AbCampaignWithStats = Doc<'campaigns'> & {
	abStats: {
		status: Doc<'campaigns'>['abTestStatus'];
		winner: Doc<'campaigns'>['abWinner'];
		winnerSelectedAt: Doc<'campaigns'>['abWinnerSelectedAt'];
		config: NonNullable<Doc<'campaigns'>['abTestConfig']> | null;
		variantA: AbVariantStats;
		variantB: AbVariantStats;
	};
};

/** Safety cap on the A/B campaign list (the `.filter` scan can't use an index). */
const AB_LIST_LIMIT = 200;

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

/** The ≤200 A/B campaign docs — bounded scan of `campaigns`, no per-variant
 * `emailSends` reads. Internal half of the action below. */
export const listABTestCampaignDocs = internalQuery({
	args: {},
	handler: async (ctx) =>
		ctx.db
			.query('campaigns')
			.withIndex('by_is_ab_test', (q) => q.eq('isABTest', true))
			.take(AB_LIST_LIMIT),
});

/** One campaign's per-variant stats — a single bounded `emailSends` read
 * (≤2×AB_VARIANT_SCAN_LIMIT) via `loadAbTestStats`. Internal half of the
 * action below. */
export const getAbVariantStatsForCampaign = internalQuery({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args): Promise<{ variantA: AbVariantStats; variantB: AbVariantStats }> =>
		loadAbTestStats(ctx, args.campaignId),
});

/**
 * All A/B test campaigns with per-variant stats. An ACTION, not a reactive
 * query: the per-variant breakdown only exists in the `emailSends` rows, so a
 * reactive query fanned out up to ~200 campaigns × two 10k scans = millions of
 * reads in ONE subscription that re-executed on every `emailSends` write. The
 * action loads the bounded campaign list once, then each campaign's variant
 * stats in its OWN bounded internal query (≤20k reads each — never the whole
 * fan-out in one transaction), and does not re-run on Contacts/sends writes.
 * The web caller loads it on mount.
 */
// all-members: read-only A/B analytics for the org's own campaigns.
export const getABTestCampaignsByOrganization = authedAction({
	args: {},
	handler: async (ctx): Promise<AbCampaignWithStats[]> => {
		const campaigns: Doc<'campaigns'>[] = await ctx.runQuery(
			internal.campaigns.analytics.listABTestCampaignDocs,
			{}
		);

		const campaignsWithStats: AbCampaignWithStats[] = await Promise.all(
			campaigns.map(async (campaign): Promise<AbCampaignWithStats> => {
				const { variantA, variantB } = await ctx.runQuery(
					internal.campaigns.analytics.getAbVariantStatsForCampaign,
					{ campaignId: campaign._id }
				);
				return {
					...campaign,
					abStats: {
						status: campaign.abTestStatus,
						winner: campaign.abWinner,
						winnerSelectedAt: campaign.abWinnerSelectedAt,
						config: campaign.abTestConfig ?? null,
						variantA,
						variantB,
					},
				};
			})
		);

		// Sort by updatedAt descending (most recent first)
		return campaignsWithStats.sort((a, b) => b.updatedAt - a.updatedAt);
	},
});
