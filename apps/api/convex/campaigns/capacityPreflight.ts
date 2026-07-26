/**
 * Binding capacity pre-flight — the ctx-bound half of the P0-5 capacity gate
 * (deliverability plan rev 3). The pure predicate lives in `capacityPlan.ts`;
 * this module only LOADS its inputs (warming state, audience size) and maps
 * "we could not measure" onto "allow the send".
 *
 * Two rules govern everything here:
 *
 *  - NEVER refuse on missing data (plan D2/D10). No warming state, stale
 *    warming state, a graduated deployment with no cap, or a projection with
 *    no positive capacity at all all resolve to "capacity unknown → allow".
 *    Blocking a campaign because we could not read warming state would be
 *    exactly the false blocker the plan forbids.
 *  - The projection is an UPPER bound. Per-IP caps come from the published
 *    warming schedule, which the MTA treats as a ceiling, and every active IP
 *    is counted regardless of pool. Refusing against an optimistic projection
 *    is sound: if the best case cannot finish, reality cannot either.
 */

import { v } from 'convex/values';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import { getWarmingDisplayCapForDay } from '@owlat/shared/warming';
import { internal } from '../_generated/api';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { getUserIdFromSession } from '../lib/sessionOrganization';
import { audienceValidator, type StoredAudience } from './audience';
import { planCampaignCapacity, type CampaignCapacityPlan } from './capacityPlan';

type Ctx = MutationCtx | QueryCtx;

/** How many days of capacity the projection covers. */
export const CAPACITY_PROJECTION_DAYS = 30;

/**
 * Warming state older than this is not trustworthy enough to refuse a send on.
 * The sync runs every five minutes, so a day of silence means the pipe is
 * broken — and a broken measurement pipe must never block sending.
 */
export const WARMING_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Multi-day plan plus whether capacity could be measured at all. */
export type CampaignCapacityAssessment = CampaignCapacityPlan & { capacityKnown: boolean };

/**
 * Project sendable volume per day from the cached MTA warming state.
 * Returns `null` whenever capacity is UNKNOWN or effectively unbounded.
 */
export async function loadRemainingCapacityByDay(ctx: Ctx, now: number): Promise<number[] | null> {
	const warmingState = await ctx.db.query('warmingState').first();
	if (!warmingState) return null;

	// Stale state: the MTA sync has stopped. Unknown, not zero.
	if (
		!Number.isFinite(warmingState.syncedAt) ||
		now - warmingState.syncedAt > WARMING_STATE_MAX_AGE_MS
	) {
		return null;
	}

	// Graduated deployments have no warming cap at all — nothing to bind against.
	if (warmingState.phase === 'graduated') return null;

	const activeIps = warmingState.ips.filter(
		(ip) => ip.active && ip.phase !== 'graduated' && Number.isFinite(ip.currentDay)
	);
	if (activeIps.length === 0) return null;

	const totalDailyCap = Number.isFinite(warmingState.totalDailyCap)
		? warmingState.totalDailyCap
		: 0;
	const totalSentToday = Number.isFinite(warmingState.totalSentToday)
		? warmingState.totalSentToday
		: 0;

	const byDay: number[] = [Math.max(0, totalDailyCap - totalSentToday)];
	for (let day = 1; day < CAPACITY_PROJECTION_DAYS; day += 1) {
		let projected = 0;
		for (const ip of activeIps) {
			projected += getWarmingDisplayCapForDay(Math.floor(ip.currentDay) + day);
		}
		byDay.push(projected);
	}
	return byDay;
}

/**
 * Decide whether `audience` can be delivered inside the message-retention
 * horizon. Unknown capacity and unplannable projections both answer
 * `{ fits: true, capacityKnown: false }` — hold and allow.
 */
export async function assessCampaignCapacity(
	ctx: Ctx,
	options: { audience: StoredAudience; now: number }
): Promise<CampaignCapacityAssessment> {
	const remainingCapacityByDay = await loadRemainingCapacityByDay(ctx, options.now);
	if (remainingCapacityByDay === null) return { fits: true, capacityKnown: false };

	const counted = await ctx.runQuery(
		internal.campaigns.audienceResolution.countRecipientsInternal,
		{
			audience: options.audience,
		}
	);

	const plan = planCampaignCapacity({
		// `eligible` is a lower bound when the count is capped, and refusing on a
		// lower bound is sound: a bigger audience fits even less well.
		audienceSize: counted.eligible,
		remainingCapacityByDay,
		maxMessageAgeMs: GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
		now: options.now,
	});

	if (plan.fits) return { ...plan, capacityKnown: true };
	// `days === 0` is the planner's "no capacity to schedule against" sentinel.
	if (plan.days === 0) return { fits: true, capacityKnown: false };
	return { ...plan, capacityKnown: true };
}

/**
 * UI-facing preview of the same assessment, so the campaign wizard can offer
 * "Sending over N days" as a first-class choice before the operator hits send.
 * A multi-day send is a normal, visible state for a warming deployment — never
 * an error, never a surprise.
 */
export const getCampaignCapacityPlan = authedQuery({
	args: { audience: v.optional(audienceValidator) },
	handler: async (ctx, args): Promise<CampaignCapacityAssessment> => {
		await getUserIdFromSession(ctx);
		if (!args.audience) return { fits: true, capacityKnown: false };
		return await assessCampaignCapacity(ctx, { audience: args.audience, now: Date.now() });
	},
});
