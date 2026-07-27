/**
 * Warming capacity projection — how much campaign volume the deployment can
 * send per day, projected forward from the cached MTA warming state.
 *
 * This is a WARMING concern, not a campaign one: the campaign pre-flight gate
 * (`campaigns/capacityPreflight.ts`) and the advisory send estimate
 * (`analytics/reputationQueries.ts`) both consume it, so it lives beside the
 * rest of the delivery domain rather than inside either caller.
 *
 * Two rules govern everything here:
 *
 *  - NEVER report zero for something we could not measure (plan D2/D10).
 *    Missing state, stale state, no active campaign IPs, or an effectively
 *    unbounded (graduated) pool all answer `null` — "capacity unknown" — and
 *    every caller maps that onto "allow the send".
 *  - The projection is an UPPER bound. Per-IP caps come from the published
 *    warming schedule, which the MTA treats as a ceiling. Refusing against an
 *    optimistic projection is sound: if the best case cannot finish, reality
 *    cannot either. To stay an upper bound the array ENDS at the last day it can
 *    bound — schedule day 30 lifts the cap entirely — so callers must treat a
 *    short array as "unknown beyond here", never as "zero beyond here".
 */

import { getWarmingCapForDay } from '@owlat/shared/warming';
import type { MutationCtx, QueryCtx } from '../_generated/server';

type Ctx = MutationCtx | QueryCtx;

/** Milliseconds in a UTC day — the granularity the warming cap resets on. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** How many days of capacity the projection covers. */
const CAPACITY_PROJECTION_DAYS = 30;

/**
 * Warming state older than this is not trustworthy enough to refuse a send on.
 * The sync runs every five minutes, so a day of silence means the pipe is
 * broken — and a broken measurement pipe must never block sending.
 */
const WARMING_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface WarmingCapacityOptions {
	/** Current wall-clock time (ms since epoch); staleness is judged against it. */
	now: number;
	/**
	 * The instant the send actually starts (a scheduled fire time, or `now` for
	 * an immediate send). Defaults to `now`. Index 0 of the returned array is
	 * the capacity available on this instant's UTC day: the remainder of today
	 * when it IS today, or a whole projected day when it is in the future — a
	 * send scheduled three days out must be judged against the cap it will have
	 * THEN, not against today's. Anchoring a future send at `now` is strictly
	 * pessimistic under a monotonically growing warming schedule and would
	 * refuse campaigns that provably fit.
	 */
	startsAt?: number;
}

/**
 * Project sendable campaign volume per day. Returns `null` whenever capacity
 * is UNKNOWN or effectively unbounded.
 *
 * ONE population throughout: active IPs in the CAMPAIGN pool, every one of
 * them placeable on the warming schedule. Index 0 (today's remainder) is summed
 * per-IP over that SAME list rather than taken from `warmingState.totalDailyCap`
 * / `totalSentToday` — those roll up every campaign-pool IP regardless of
 * `active` (`packages/shared/src/ipReadinessSync.ts` has no `active` test), so a
 * deactivated campaign IP would inflate index 0 alone and the two halves of one
 * array would count different IPs. If any IP in the population cannot be placed
 * on the schedule (a non-finite `currentDay`), the projection would silently
 * drop it for k>0 while index 0 still counted it: unknown, not partial.
 *
 * A graduated campaign IP has no warming ceiling at all — it is counted in
 * `totalDailyCap` at `GRADUATED_DISPLAY_CAP`, a display sentinel, not a real
 * limit. One graduated IP therefore makes the whole projection unbounded, so
 * we answer `null` rather than pretend to a number. This matters: the overall
 * `warmingState.phase` is only `'graduated'` when NO campaign IP is ramping or
 * plateauing, so a deployment of three graduated IPs plus one freshly added
 * day-1 IP reports phase `'ramp'` and would otherwise be projected as if only
 * the day-1 IP existed — a false blocker for campaigns the graduated IPs could
 * deliver instantly.
 */
export async function loadRemainingCapacityByDay(
	ctx: Ctx,
	options: WarmingCapacityOptions
): Promise<number[] | null> {
	const warmingState = await ctx.db.query('warmingState').first();
	if (!warmingState) return null;

	// Stale state: the MTA sync has stopped. Unknown, not zero.
	if (
		!Number.isFinite(warmingState.syncedAt) ||
		options.now - warmingState.syncedAt > WARMING_STATE_MAX_AGE_MS
	) {
		return null;
	}

	// Graduated deployments have no warming cap at all — nothing to bind against.
	if (warmingState.phase === 'graduated') return null;

	const campaignIps = warmingState.ips.filter((ip) => ip.active && ip.pool === 'campaign');
	if (campaignIps.length === 0) return null;
	// Any graduated campaign IP ⇒ effectively unbounded capacity (see above).
	if (campaignIps.some((ip) => ip.phase === 'graduated')) return null;

	// One unplaceable IP makes the whole population unprojectable (see above).
	if (campaignIps.some((ip) => !Number.isFinite(ip.currentDay))) return null;

	// Whole UTC days between now and the anchor. Clock skew (an anchor in the
	// past, a non-finite anchor) collapses to 0 — i.e. "starts today".
	const startsAt = options.startsAt ?? options.now;
	const anchorDayOffset =
		Number.isFinite(startsAt) && Number.isFinite(options.now)
			? Math.max(0, Math.floor(startsAt / MS_PER_DAY) - Math.floor(options.now / MS_PER_DAY))
			: 0;

	const byDay: number[] = [];
	if (anchorDayOffset === 0) {
		// Only today's slice is partially consumed; every later day is whole. Summed
		// per-IP over the SAME population index k>0 projects, and floored per-IP so
		// one over-sent IP cannot eat another's headroom.
		let remainingToday = 0;
		for (const ip of campaignIps) {
			const dailyCap = Number.isFinite(ip.dailyCap) ? ip.dailyCap : 0;
			const sentToday = Number.isFinite(ip.sentToday) ? ip.sentToday : 0;
			remainingToday += Math.max(0, dailyCap - sentToday);
		}
		byDay.push(remainingToday);
	}
	for (
		let day = Math.max(1, anchorDayOffset);
		day < CAPACITY_PROJECTION_DAYS + anchorDayOffset;
		day += 1
	) {
		let projected = 0;
		let unbounded = false;
		for (const ip of campaignIps) {
			const cap = getWarmingCapForDay(Math.floor(ip.currentDay) + day);
			if (!Number.isFinite(cap)) {
				unbounded = true;
				break;
			}
			projected += cap;
		}
		// Schedule day 30 is `Infinity`: the MTA stops throttling there. That is
		// UNBOUNDED capacity, not `GRADUATED_DISPLAY_CAP` — clamping it would turn
		// the projection into a LOWER bound and let the gate refuse a campaign that
		// actually fits. Stop at the last day we can bound instead, and never push
		// `Infinity` into the array (the planner's `sanitizeCount` maps it to 0,
		// which reads as "no capacity" — the exact inversion of the truth).
		if (unbounded) break;
		byDay.push(projected);
	}
	if (byDay.length === 0) return null;
	return byDay;
}
