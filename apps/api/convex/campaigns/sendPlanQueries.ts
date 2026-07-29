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
import { loadPacedWarmingCapacity } from '../delivery/pacedWarmingCapacity';
import { audienceValidator } from './audience';
import { countAudience } from './audienceCandidates';
import { totalPlannableCapacity } from './capacityPlan';
import { campaignSendPlanProgress, type CampaignSendPlanProgress } from './sendPlanProgress';

/**
 * Documents the plan's audience count may read. Deliberately SMALLER than the
 * pre-flight gate's budget: this count is advisory — it is the denominator of a
 * progress line, never a refusal — so it may not compete with the send hop's own
 * reads. A count that stops early yields a LOWER bound, which the copy says out
 * loud rather than rounding into a promise (plan D14).
 */
const PLAN_AUDIENCE_DOCUMENT_BUDGET = 3_000;

export interface SendPlanCapacity {
	readonly capacityByDay: number[];
	/**
	 * The audience size, or `null` when it was not counted on this hop.
	 * `isPlannedTotalLowerBound` says WHICH OF TWO THINGS the number is: an
	 * audience size, or the floor under one (plan D14). The distinction is
	 * load-bearing — a lower bound may lengthen the plan, may never shorten it,
	 * and may never be read as "the audience is finished".
	 */
	readonly plannedTotal: number | null;
	readonly isPlannedTotalLowerBound: boolean;
	/**
	 * Did the count ACTUALLY RUN on this hop, whatever verdict it reached?
	 *
	 * Distinct from `plannedTotal !== null` because one reading — an over-count
	 * truncated by suppression — is counted and yet UNUSABLE, and without this
	 * flag the walk could not tell "not counted yet" from "counted, and the answer
	 * was no answer". It would then re-run a 3 000-document count on EVERY
	 * remaining hop of the walk, which for a large audience is tens of thousands
	 * of wasted document reads on the send path. The count is attempted ONCE per
	 * walk, exactly as this module's own doc claims.
	 */
	readonly isPlannedTotalCounted: boolean;
}

export const getSendPlanCapacity = internalQuery({
	args: {
		audience: audienceValidator,
		/** Skip the audience count once the walk already has a denominator. */
		countAudienceSize: v.boolean(),
	},
	handler: async (ctx, args): Promise<SendPlanCapacity> => {
		const now = Date.now();
		// THE PACED PROJECTION, from the ONE place that derives it
		// (`delivery/pacedWarmingCapacity.ts`). The binding pre-flight and the
		// operator-facing send estimate read the SAME function, so the day count the
		// gate blessed, the day count the screen quotes and the day budget this
		// walker meters can never disagree — the disagreement this repo already paid
		// for once (`analytics/reputationQueries.ts`: "one projection, one
		// population, one answer").
		//
		// NO PROJECTION IS NOT A ZERO PROJECTION. An empty array is the planner's
		// "unknown capacity" reading and imposes no budget at all.
		const projection = await loadPacedWarmingCapacity(ctx, { now });
		const capacityByDay = projection === null ? [] : projection.byDay;
		if (projection === null || !args.countAudienceSize) {
			return {
				capacityByDay,
				plannedTotal: null,
				isPlannedTotalLowerBound: false,
				isPlannedTotalCounted: false,
			};
		}
		const counted = await countAudience(ctx, args.audience, {
			ceiling: totalPlannableCapacity(capacityByDay) + 1,
			documentBudget: PLAN_AUDIENCE_DOCUMENT_BUDGET,
		});
		// `suppression_truncated` is an OVER-count: it bounds the audience in
		// NEITHER direction, so it licenses nothing at all and is discarded rather
		// than quoted as a floor (see `AudienceCountCompleteness`). The other two
		// partial readings are honest lower bounds and are kept as such.
		//
		// IT IS STILL A COUNT THAT RAN. Re-running it every hop would not turn it
		// usable — the audience has not changed — so the verdict is recorded and the
		// walk stops paying for it.
		if (counted.completeness === 'suppression_truncated') {
			return {
				capacityByDay,
				plannedTotal: null,
				isPlannedTotalLowerBound: false,
				isPlannedTotalCounted: true,
			};
		}
		return {
			capacityByDay,
			plannedTotal: counted.eligible,
			isPlannedTotalLowerBound: counted.completeness !== 'exact',
			isPlannedTotalCounted: true,
		};
	},
});

/**
 * THE PROGRESS LINE — "Sending over 4 days · day 1 of 4 · 5 000 of 20 000".
 *
 * Present from the moment the send starts, and NEVER an error state: a
 * multi-day send is a normal, visible state for a warming deployment (plan
 * D14). A campaign with no walk IN FLIGHT answers `null`, which the UI renders
 * as nothing at all rather than as a problem — and that is why the phase is
 * checked at all: `campaignSendJobs` rows outlive the walk, and the report page
 * is mostly read for campaigns that finished sending days ago. A present-tense
 * sentence about a finished send is worse than no sentence.
 */
// all-members: campaign send progress — the same member-visible surface as the
// campaign report it renders on (see campaigns/analytics.ts).
export const getCampaignSendPlan = authedQuery({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args): Promise<CampaignSendPlanProgress | null> => {
		const job = await ctx.db
			.query('campaignSendJobs')
			.withIndex('by_campaign', (q) => q.eq('campaignId', args.campaignId))
			.first();
		if (!job || job.phase !== 'resolving') return null;
		return campaignSendPlanProgress({
			plan: {
				planDayKey: job.planDayKey,
				enqueuedToday: job.enqueuedToday,
				planDayIndex: job.planDayIndex,
				planTotalDays: job.planTotalDays,
				plannedTotal: job.plannedTotal,
				isPlannedTotalLowerBound: job.isPlannedTotalLowerBound,
			},
			enqueuedCount: job.enqueuedCount,
		});
	},
});
