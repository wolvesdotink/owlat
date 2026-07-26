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
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { audienceValidator, type StoredAudience } from './audience';
import { countAudience } from './audienceResolution';
import {
	MAX_PLAN_DAYS,
	MS_PER_DAY,
	planCampaignCapacity,
	type CampaignCapacityPlan,
	type CampaignCapacitySchedule,
} from './capacityPlan';

type Ctx = MutationCtx | QueryCtx;

/** How many days of capacity the projection covers. */
export const CAPACITY_PROJECTION_DAYS = 30;

/**
 * Warming state older than this is not trustworthy enough to refuse a send on.
 * The sync runs every five minutes, so a day of silence means the pipe is
 * broken — and a broken measurement pipe must never block sending.
 */
export const WARMING_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Multi-day plan plus whether capacity could be measured at all.
 *
 * Modelled as a discriminated union rather than `plan & { capacityKnown }` so
 * the unrepresentable "we refused, but we could not measure capacity" state
 * cannot be constructed: an unmeasured assessment is ALWAYS `fits: true`.
 */
export type CampaignCapacityAssessment =
	| { capacityKnown: false; fits: true }
	| { capacityKnown: true; fits: true }
	| { capacityKnown: true; fits: false; schedule: CampaignCapacitySchedule };

/**
 * Project sendable volume per day from the cached MTA warming state.
 * Returns `null` whenever capacity is UNKNOWN or effectively unbounded.
 *
 * `anchorAt` is the instant the send actually starts (the scheduled fire time,
 * or now for an immediate send). Index 0 of the returned array is the capacity
 * available on the anchor's UTC day: the remainder of today when the anchor is
 * today, or a whole projected day when the anchor is in the future — a send
 * scheduled three days out must be judged against the cap it will have THEN,
 * not against today's. Anchoring at `now` for a future send is strictly
 * pessimistic under a monotonically growing warming schedule and would refuse
 * campaigns that provably fit.
 */
export async function loadRemainingCapacityByDay(
	ctx: Ctx,
	now: number,
	anchorAt: number = now
): Promise<number[] | null> {
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

	// Whole UTC days between now and the anchor. Clock skew (an anchor in the
	// past, a non-finite anchor) collapses to 0 — i.e. "starts today".
	const anchorDayOffset = Number.isFinite(anchorAt)
		? Math.max(0, Math.floor(anchorAt / MS_PER_DAY) - Math.floor(now / MS_PER_DAY))
		: 0;

	const byDay: number[] = [];
	if (anchorDayOffset === 0) {
		const totalDailyCap = Number.isFinite(warmingState.totalDailyCap)
			? warmingState.totalDailyCap
			: 0;
		const totalSentToday = Number.isFinite(warmingState.totalSentToday)
			? warmingState.totalSentToday
			: 0;
		// Only today's slice is partially consumed; every later day is whole.
		byDay.push(Math.max(0, totalDailyCap - totalSentToday));
	}
	for (
		let day = Math.max(1, anchorDayOffset);
		day < CAPACITY_PROJECTION_DAYS + anchorDayOffset;
		day += 1
	) {
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
 *
 * `startsAt` (default `now`) is when the send begins; the projection AND the
 * retention horizon are both anchored there so a future-scheduled campaign is
 * judged against the capacity it will actually have.
 */
export async function assessCampaignCapacity(
	ctx: Ctx,
	options: { audience: StoredAudience; now: number; startsAt?: number }
): Promise<CampaignCapacityAssessment> {
	const startsAt = Math.max(options.now, options.startsAt ?? options.now);
	const remainingCapacityByDay = await loadRemainingCapacityByDay(ctx, options.now, startsAt);
	if (remainingCapacityByDay === null) return { capacityKnown: false, fits: true };

	// Bound the hot-path read cost by CAPACITY, not by audience size. The verdict
	// is already decided once the count exceeds everything the deployment could
	// possibly send across the whole plan window, so there is no reason to stream
	// tens of thousands of audience documents inside a send mutation. A capped
	// count is a sound lower bound and refusing on a lower bound is sound.
	const trailingRate = remainingCapacityByDay[remainingCapacityByDay.length - 1] ?? 0;
	const projectedTotal =
		remainingCapacityByDay.reduce((sum, day) => sum + day, 0) +
		Math.max(0, MAX_PLAN_DAYS - remainingCapacityByDay.length) * trailingRate;
	const counted = await countAudience(ctx, options.audience, {
		ceiling: Math.min(Number.MAX_SAFE_INTEGER, projectedTotal + 1),
	});

	const plan = planCampaignCapacity({
		// `eligible` is a lower bound when the count is capped, and refusing on a
		// lower bound is sound: a bigger audience fits even less well.
		audienceSize: counted.eligible,
		remainingCapacityByDay,
		maxMessageAgeMs: GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
		now: startsAt,
	});

	return toAssessment(plan);
}

/**
 * Map a planner verdict onto an assessment. Pure, and exported so the
 * "unplannable → allow" branch is directly testable: real warming caps are
 * never zero, so the sentinel is unreachable through seeded integration state
 * and would otherwise ship untested.
 */
export function toAssessment(plan: CampaignCapacityPlan): CampaignCapacityAssessment {
	if (plan.fits) return { capacityKnown: true, fits: true };
	// `days === 0` is the planner's "no capacity to schedule against" sentinel:
	// nothing could be scheduled, or the projection plateaus at zero before the
	// audience is covered. Either way it is missing data, not a refusal.
	if (plan.days === 0) return { capacityKnown: false, fits: true };
	return { capacityKnown: true, fits: false, schedule: plan };
}

/**
 * UI-facing preview of the same assessment, so the campaign wizard can offer
 * "Sending over N days" as a first-class choice before the operator hits send.
 * A multi-day send is a normal, visible state for a warming deployment — never
 * an error, never a surprise.
 */
// all-members: deployment-wide sending capacity is not per-user data — it is the
// same warming projection every delivery screen already renders to any member,
// and the caller supplies the audience it is about to preview. No row is read
// that a member cannot already read through countRecipients / the warming pages.
export const getCampaignCapacityPlan = authedQuery({
	args: { audience: v.optional(audienceValidator), startsAt: v.optional(v.number()) },
	handler: async (ctx, args): Promise<CampaignCapacityAssessment> => {
		if (!args.audience) return { capacityKnown: false, fits: true };
		return await assessCampaignCapacity(ctx, {
			audience: args.audience,
			now: Date.now(),
			...(args.startsAt !== undefined ? { startsAt: args.startsAt } : {}),
		});
	},
});
