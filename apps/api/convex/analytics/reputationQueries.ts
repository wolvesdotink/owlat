import { v } from 'convex/values';
import { authedQuery } from '../lib/authedFunctions';
import { getUserIdFromSession } from '../lib/sessionOrganization';
import { getDailySendVolume } from '../lib/sendingLimits';
import { summarize, summarizeDomains, type ReputationSummary } from './sendingReputation';

/** The reputation card's UI shape, or `null` when there's no in-window activity. */
type ReputationDto = {
	bounceRate: number;
	complaintRate: number;
	riskLevel: string;
	totalSent: number;
	totalDelivered: number;
	totalBounced: number;
	totalComplaints: number;
} | null;

/**
 * Shape a rolling reputation summary for the overview card. Returns `null`
 * when the window has no sending activity yet, so the UI can render its empty
 * state instead of an all-zero "0% bounce" card that reads like a real signal.
 * Pure — no DB access — so the null-vs-populated decision is unit-testable.
 */
export function toReputationDto(summary: ReputationSummary): ReputationDto {
	const hasActivity =
		summary.totalSent > 0 ||
		summary.totalDelivered > 0 ||
		summary.totalBounced > 0 ||
		summary.totalComplaints > 0;

	if (!hasActivity) return null;

	return {
		bounceRate: summary.bounceRate,
		complaintRate: summary.complaintRate,
		riskLevel: summary.riskLevel,
		totalSent: summary.totalSent,
		totalDelivered: summary.totalDelivered,
		totalBounced: summary.totalBounced,
		totalComplaints: summary.totalComplaints,
	};
}

// ============ PUBLIC QUERIES ============

/**
 * Get sending overview: warming state, volume, reputation, abuse status.
 * Tier-based limits have been removed — IP warming is handled by the MTA.
 */
export const getSendingOverview = authedQuery({
	args: {},
	handler: async (ctx) => {
		await getUserIdFromSession(ctx);

		// Get instance settings
		const settings = await ctx.db
			.query('instanceSettings')
			.first();

		if (!settings) {
			return null;
		}

		// Get warming state from MTA sync
		const warmingState = await ctx.db.query('warmingState').first();

		// Compute volume tracking
		const volume = getDailySendVolume(
			settings.dailySendCount ?? 0,
			settings.dailySendCountResetAt,
		);

		// Rolling 30-day org reputation, derived on read through the single
		// summarizer, then shaped for the card (`null` on no in-window
		// activity, so the UI can show its empty state).
		const orgSummary = await summarize(ctx.db, { kind: 'org' });
		const reputation = toReputationDto(orgSummary);

		return {
			warming: warmingState
				? {
					phase: warmingState.phase,
					totalDailyCap: warmingState.totalDailyCap,
					totalSentToday: warmingState.totalSentToday,
					remainingToday: Math.max(0, warmingState.totalDailyCap - warmingState.totalSentToday),
					ipCount: warmingState.ipCount,
					ips: warmingState.ips,
					syncedAt: warmingState.syncedAt,
				}
				: null,
			volume,
			reputation,
			abuseStatus: settings.abuseStatus ?? null,
		};
	},
});

/**
 * Estimate how long a campaign will take to send based on IP warming state.
 */
export const getCampaignSendEstimate = authedQuery({
	args: {
		recipientCount: v.number(),
	},
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);

		const warmingState = await ctx.db.query('warmingState').first();

		if (!warmingState) {
			return {
				totalDailyCap: 0,
				remainingToday: 0,
				estimatedDays: 1,
				isFullyWarmed: false,
				message: 'Warming data not available yet. Your emails will be paced automatically.',
			};
		}

		const { totalDailyCap, totalSentToday } = warmingState;
		const remainingToday = Math.max(0, totalDailyCap - totalSentToday);

		// Check if all IPs are graduated
		const isFullyWarmed = warmingState.phase === 'graduated';

		if (isFullyWarmed) {
			return {
				totalDailyCap,
				remainingToday,
				estimatedDays: 1,
				isFullyWarmed: true,
				message: 'Your IPs are fully warmed. Campaign will send at full speed.',
			};
		}

		// Estimate days needed
		const { recipientCount } = args;
		if (recipientCount <= remainingToday) {
			return {
				totalDailyCap,
				remainingToday,
				estimatedDays: 1,
				isFullyWarmed: false,
				message: `Campaign fits within today's remaining capacity (${remainingToday.toLocaleString()} emails).`,
			};
		}

		// Project forward: assume daily cap roughly doubles each day (conservative estimate)
		let remaining = recipientCount - remainingToday;
		let days = 1;
		let projectedDailyCap = totalDailyCap;

		while (remaining > 0 && days < 30) {
			days++;
			// Conservative: cap increases ~1.5x per day during warmup
			projectedDailyCap = Math.min(projectedDailyCap * 1.5, 200000);
			remaining -= projectedDailyCap;
		}

		const message = days >= 30
			? 'Campaign will take approximately 30+ days based on current warmup progress.'
			: `Based on your IP warmup progress, this campaign will take approximately ${days} day${days === 1 ? '' : 's'} to complete.`;

		return {
			totalDailyCap,
			remainingToday,
			estimatedDays: days,
			isFullyWarmed: false,
			message,
		};
	},
});

/**
 * Get per-domain reputation summaries.
 */
export const getDomainReputations = authedQuery({
	args: {},
	handler: async (ctx) => {
		await getUserIdFromSession(ctx);

		// Per-domain rolling summaries, derived on read through the single
		// summarizer (grouped by domain).
		const summaries = await summarizeDomains(ctx.db);

		// Join verification status from the domains table.
		const domains = await ctx.db
			.query('domains')
			.collect(); // bounded: org-curated sending domains, low-tens at most

		const domainStatusMap = new Map<string, string>();
		for (const d of domains) {
			domainStatusMap.set(d.domain, d.status);
		}

		const results = summaries.map((s) => ({
			domain: s.domain,
			riskLevel: s.riskLevel as string,
			bounceRate: s.bounceRate,
			complaintRate: s.complaintRate,
			totalSent: s.totalSent,
			totalBounced: s.totalBounced,
			totalComplaints: s.totalComplaints,
			domainStatus: domainStatusMap.get(s.domain) ?? null,
		}));

		// Sort by totalSent descending (most active domains first)
		results.sort((a, b) => b.totalSent - a.totalSent);

		return results;
	},
});
