/**
 * The Marketing overview's one read: how the latest campaigns did, how all
 * campaigns did over the last 30 days, and the delivery signals that sit next
 * to them. Performance only — what's scheduled or waiting on a decision comes
 * from the existing campaign list queries the page already uses.
 *
 * Every read is an index-ordered, capped `take` on `campaigns.by_status_sent_at`
 * plus the bounded daily roll-up and reputation reads; no `emailSends` row is
 * touched, so the subscription stays cheap however large the sends get. The
 * math lives in `marketingOverviewMath.ts` and is tested there.
 */
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { readDailyStats } from '../lib/sendDailyStats';
import { readOrgReputation } from './reputationQueries';
import {
	WEEK_MS,
	automatedOpenSummary,
	denseDailyOpens,
	engagementRates,
	inWindow,
	periodTotals,
	sendingProgress,
	weeklyTotals,
	weightedAverageRates,
	type DatedCampaignCounts,
} from './marketingOverviewMath';

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_DAYS = 30;
const WEEKLY_BUCKETS = 12;
const LATEST_COUNT = 3;
const RECENT_COUNT = 10;
/**
 * Cap on campaigns read for the 12-week window. Three sends a day for 84 days
 * is ~250, so this is generous; past it the oldest weeks undercount, never the
 * current period.
 */
const WINDOW_CAP = 500;

type SentStatus = 'sent' | 'sending';
type DatedCampaign = Doc<'campaigns'> & { sentAt: number };

function hasSentAt(c: Doc<'campaigns'>): c is DatedCampaign {
	return c.sentAt !== undefined;
}

function countsOf(c: DatedCampaign): DatedCampaignCounts {
	return {
		sentAt: c.sentAt,
		sent: c.statsSent ?? 0,
		delivered: c.statsDelivered ?? 0,
		opened: c.statsOpened ?? 0,
		clicked: c.statsClicked ?? 0,
		unsubscribed: c.statsUnsubscribed ?? 0,
		bounced: c.statsBounced ?? 0,
	};
}

/** Newest-first campaigns of one status, optionally only those sent since `since`. */
async function readByStatus(
	ctx: QueryCtx,
	status: SentStatus,
	limit: number,
	since?: number
): Promise<DatedCampaign[]> {
	const rows = await ctx.db
		.query('campaigns')
		.withIndex('by_status_sent_at', (q) =>
			since === undefined ? q.eq('status', status) : q.eq('status', status).gte('sentAt', since)
		)
		.order('desc')
		.take(limit);
	return rows.filter(hasSentAt);
}

/** Live progress for a campaign still sending, from its send walk if one exists. */
async function progressOf(ctx: QueryCtx, c: DatedCampaign): Promise<number | undefined> {
	const walk = await ctx.db
		.query('campaignSendJobs')
		.withIndex('by_campaign', (q) => q.eq('campaignId', c._id))
		.first();
	return sendingProgress(c.statsSent ?? 0, walk);
}

// all-members: aggregated campaign counters and org-wide delivery rates — the
// same member-visible numbers the campaign list and report already show.
export const get = authedQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'campaigns');
		const now = Date.now();

		// Band 1: the newest sends, a still-sending one included.
		const [latestSent, latestSending] = await Promise.all([
			readByStatus(ctx, 'sent', LATEST_COUNT),
			readByStatus(ctx, 'sending', LATEST_COUNT),
		]);
		const latestRows = [...latestSending, ...latestSent]
			.sort((a, b) => b.sentAt - a.sentAt)
			.slice(0, LATEST_COUNT);
		const latest = await Promise.all(
			latestRows.map(async (c) => {
				const counts = countsOf(c);
				const isSending = c.status === 'sending';
				const progress = isSending ? await progressOf(ctx, c) : undefined;
				return {
					id: c._id,
					name: c.name,
					sentAt: c.sentAt,
					sent: counts.sent,
					delivered: counts.delivered,
					opened: counts.opened,
					clicked: counts.clicked,
					unsubscribed: counts.unsubscribed,
					bounced: counts.bounced,
					isSending,
					...(progress === undefined ? {} : { progress }),
				};
			})
		);

		// The comparison baseline: the last finished sends, oldest first.
		const recentRows = (await readByStatus(ctx, 'sent', RECENT_COUNT)).reverse();
		const recentCounts = recentRows.map(countsOf);
		const recent = {
			campaigns: recentRows.map((c, i) => ({
				id: c._id,
				name: c.name,
				sentAt: c.sentAt,
				...engagementRates(recentCounts[i]!),
			})),
			average: weightedAverageRates(recentCounts),
		};

		// Band 2: every campaign that went out in the last 12 weeks.
		const windowStart = now - WEEKLY_BUCKETS * WEEK_MS;
		const [windowSent, windowSending] = await Promise.all([
			readByStatus(ctx, 'sent', WINDOW_CAP, windowStart),
			readByStatus(ctx, 'sending', WINDOW_CAP, windowStart),
		]);
		const windowRows = [...windowSent, ...windowSending];
		const windowCounts = windowRows.map(countsOf);
		const periodMs = PERIOD_DAYS * DAY_MS;
		const currentRows = inWindow(windowRows, now - periodMs, now + 1);
		const period = {
			current: periodTotals(inWindow(windowCounts, now - periodMs, now + 1)),
			automatedOpens: automatedOpenSummary(
				currentRows.map((c) => ({
					automatedOpened: c.statsAutomatedOpened ?? 0,
					isAutomatedOpenFiltered: c.isAutomatedOpenFiltered === true,
				}))
			),
			previous: periodTotals(inWindow(windowCounts, now - 2 * periodMs, now - periodMs)),
			campaignCount: inWindow(windowCounts, now - periodMs, now + 1).length,
			weekly: weeklyTotals(windowCounts, now + 1, WEEKLY_BUCKETS),
		};

		// Campaign AND transactional opens — the roll-up does not split them, so
		// the page labels this series "all email".
		const daily = await readDailyStats(ctx.db, PERIOD_DAYS, now);
		const opensPerDay = denseDailyOpens(daily, PERIOD_DAYS, now);

		const reputation = await readOrgReputation(ctx.db);
		const delivery = {
			reputation: reputation
				? {
						bounceRate: reputation.bounceRate,
						complaintRate: reputation.complaintRate,
						riskLevel: reputation.riskLevel,
					}
				: null,
		};

		return { latest, recent, period, opensPerDay, delivery };
	},
});
