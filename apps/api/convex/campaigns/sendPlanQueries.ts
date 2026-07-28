/**
 * THE MULTI-DAY SEND PLAN'S READS — the ctx-bound half of P3-7.
 *
 * The pure planner is `multiDaySendPlan.ts`; this module only LOADS what it
 * needs (the warming projection, and — once per walk — a bounded audience count
 * for the progress line's denominator) and exposes the operator-facing progress
 * state.
 *
 * IT NEVER BLOCKS ANYTHING. A missing warming projection, a stale one, a
 * graduated deployment with no cap at all: every one of them answers "no day
 * budget", and the walker then sends exactly as the shipped single-day walker
 * always has. Capacity we could not measure has never been grounds to withhold
 * mail (plan D2).
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { loadWarmingCapacity } from '../delivery/warmingCapacity';
import { audienceValidator } from './audience';
import { countAudience } from './audienceCandidates';
import { totalPlannableCapacity } from './capacityPlan';
import { campaignSendPlanProgress, type CampaignSendPlanProgress } from './multiDaySendPlan';

/**
 * Documents the plan's audience count may read. Deliberately SMALLER than the
 * pre-flight gate's budget: this count is advisory — it is the denominator of a
 * progress line, never a refusal — so it may not compete with the send hop's own
 * reads. A count that stops early yields a LOWER bound, which the copy says out
 * loud rather than rounding into a promise (plan D14).
 */
const PLAN_AUDIENCE_DOCUMENT_BUDGET = 3_000;

export const getSendPlanCapacity = internalQuery({
	args: {
		audience: audienceValidator,
		/** Skip the audience count once the walk already has a denominator. */
		countAudienceSize: v.boolean(),
	},
	handler: async (ctx, args): Promise<{ capacityByDay: number[]; plannedTotal: number | null }> => {
		const now = Date.now();
		const projection = await loadWarmingCapacity(ctx, { now });
		// NO PROJECTION IS NOT A ZERO PROJECTION. An empty array is the planner's
		// "unknown capacity" reading and imposes no budget at all.
		if (projection === null) return { capacityByDay: [], plannedTotal: null };
		if (!args.countAudienceSize) {
			return { capacityByDay: projection.byDay, plannedTotal: null };
		}
		const counted = await countAudience(ctx, args.audience, {
			ceiling: totalPlannableCapacity(projection.byDay) + 1,
			documentBudget: PLAN_AUDIENCE_DOCUMENT_BUDGET,
		});
		return { capacityByDay: projection.byDay, plannedTotal: counted.eligible };
	},
});

/**
 * THE PROGRESS LINE — "Sending over 4 days · day 1 of 4 · 5 000 of 20 000".
 *
 * Present from the moment the send starts, and NEVER an error state: a
 * multi-day send is a normal, visible state for a warming deployment (plan
 * D14). A campaign with no walk in flight simply answers `null`, which the UI
 * renders as nothing at all rather than as a problem.
 */
export const getCampaignSendPlan = authedQuery({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args): Promise<CampaignSendPlanProgress | null> => {
		const job = await ctx.db
			.query('campaignSendJobs')
			.withIndex('by_campaign', (q) => q.eq('campaignId', args.campaignId))
			.first();
		if (!job) return null;
		return campaignSendPlanProgress({
			planDayIndex: job.planDayIndex,
			planTotalDays: job.planTotalDays,
			enqueuedCount: job.enqueuedCount,
			plannedTotal: job.plannedTotal,
		});
	},
});
