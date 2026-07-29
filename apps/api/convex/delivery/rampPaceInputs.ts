/**
 * THE PACE ACTUATOR'S READS (plan D3, D13, D15).
 *
 * `rampControllerCron.ts` decides and writes; this module is everything the
 * SECOND actuator reads — the stored dial on the route-state row, the
 * utilisation evidence from the shipped `/ip-reputation` warming sync, and the
 * dial as the capacity projection has to apply it.
 *
 * NOTHING HERE DECIDES ANYTHING. Every rule lives in `delivery/ramp/`.
 *
 * WHY NOT IN `delivery/ramp/`: that directory is the PURE core and its purity
 * guard forbids a clock or a database handle in any file it finds.
 *
 * ABSENCE IS A SUPPORTED CONFIGURATION (plan D2). No warming state, a stale
 * sync, a graduated pool, a cell that has never been evaluated: every one of
 * them answers "unknown", the actuator HOLDS on it (plan D10), and nothing
 * throws, blocks or warns.
 */

import {
	allDeliverabilityCells,
	type DeliverabilityStream,
} from '@owlat/shared/deliverabilityRouting';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { effectiveDailyCap } from './ramp/paceCeiling';
import { PACE_INITIAL_MULTIPLIER } from './ramp/paceConfig';
import type { PaceState, PaceUtilisationReading } from './ramp/paceTypes';

type Ctx = MutationCtx | QueryCtx;

/**
 * Warming state older than this says nothing about TODAY'S utilisation.
 *
 * DELIBERATELY MUCH TIGHTER THAN `warmingCapacity.ts`'s day, because the two
 * readings answer different questions. That module asks "how big is the cap",
 * which changes slowly and must never block a send on a stale reading. This one
 * asks "was the cap EXERCISED", and `sentToday` / `dailyCap` are counters that
 * reset at the UTC boundary: a reading from yesterday describes a day that is
 * over, and accepting it would let a stale snapshot satisfy `isCapExercised` and
 * buy the day's +STEP. That is the exact rule the one sanctioned D19 change
 * exists to enforce — an unexercised cap is not evidence of anything.
 *
 * The /ip-reputation sync runs every five minutes, so this is a handful of
 * missed syncs and no more. Past it the reading is `unknown`, the actuator HOLDS
 * (plan D10), and a broken measurement pipe slows the ramp instead of steering
 * it.
 */
const WARMING_STATE_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * The STORED pace state of a cell, read out VERBATIM.
 *
 * Nothing is normalised here, for the reason `readMixState` normalises nothing:
 * handing the decision function a sanitised dial would mean a row holding `-1`,
 * `9` or `NaN` arrives as a perfectly ordinary multiplier, the actuator's
 * `multiplier_unreadable` rung could never fire in production, and a corrupt row
 * would be stepped UP on the next clean tick.
 *
 * A row with NO stored multiplier is a cell the pace dial has never touched: it
 * starts at the published schedule, unmodified.
 */
export function readPaceState(row: Doc<'deliverabilityRouteStates'>): PaceState {
	return {
		multiplier: row.paceMultiplier ?? PACE_INITIAL_MULTIPLIER,
		cleanStreak: row.paceCleanStreak,
		frozenUntil: row.paceFrozenUntil,
		freezeReason: row.paceFreezeReason,
		freezeStartedAt: row.paceFreezeStartedAt,
		cooldownMs: row.paceCooldownMs,
		lastEvaluatedUtcDay: row.paceLastEvaluatedUtcDay,
		deferredAt: row.paceDeferredAt,
	};
}

/**
 * HOW MUCH OF THE CAP THE POOL ACTUALLY USED TODAY — the pace actuator's
 * evidence that the cap it holds is a cap anyone is exercising.
 *
 * Summed over the ACTIVE CAMPAIGN IPs, which is the population the warming
 * schedule the dial modifies actually governs. A missing, stale or capless
 * reading answers `unknown`, which HOLDS the dial (plan D10) — it never reads as
 * "the cap was not exercised", because those are different facts and only the
 * second one is evidence.
 */
export async function loadPaceUtilisation(
	ctx: Ctx,
	args: { now: number }
): Promise<PaceUtilisationReading> {
	const warmingState = await ctx.db.query('warmingState').first();
	if (!warmingState) return { kind: 'unknown' };
	if (!Number.isFinite(args.now)) return { kind: 'unknown' };
	if (!Number.isFinite(warmingState.syncedAt)) return { kind: 'unknown' };
	if (args.now - warmingState.syncedAt > WARMING_STATE_MAX_AGE_MS) return { kind: 'unknown' };

	let sent = 0;
	let enforcedCap = 0;
	for (const ip of warmingState.ips) {
		if (!ip.active || ip.pool !== 'campaign') continue;
		if (Number.isFinite(ip.dailyCap)) enforcedCap += Math.max(0, ip.dailyCap);
		if (Number.isFinite(ip.sentToday)) sent += Math.max(0, ip.sentToday);
	}
	// No governed IP, or a pool with no enforced cap at all (a graduated pool):
	// there is no ratio to take, and inventing one would be inventing evidence.
	if (enforcedCap <= 0) return { kind: 'unknown' };
	return { kind: 'measured', sent, enforcedCap };
}

/**
 * THE DIAL AS THE CAMPAIGN CAPACITY PROJECTION HAS TO APPLY IT.
 *
 * The projection is POOL-WIDE — one number per day for the whole campaign pool —
 * while the dial is per cell, so the bound that is sound for every cell the pool
 * carries is the SMALLEST multiplier any of them holds. A retreat anywhere in
 * the pool slows the pool; taking an average, or the cell with the best
 * evidence, would let a cell that just halved keep sending against a cap the
 * controller has already withdrawn.
 *
 * ONLY A RETREAT REACHES THIS FAR, and that is correct rather than a shortfall:
 * the published base warming schedule is a HARD CEILING the controller may never
 * exceed for the day (plan D19), and the projection is already stated in terms
 * of that ceiling. The dial's increase range buys per-(IP x mailboxProvider)
 * headroom BELOW the IP's published cap, which is enforced inside the MTA's
 * own provider store — so it neither can nor should lift this pool-wide number.
 */
export async function loadCampaignPaceMultiplier(
	ctx: Ctx,
	args: { organizationId: string; stream: DeliverabilityStream }
): Promise<number> {
	const cells = allDeliverabilityCells().filter((cell) => cell.stream === args.stream);
	// THE PER-STREAM ROW ONLY, off `by_org_provider_stream` DIRECTLY. The general
	// `loadRouteStateCell` also loads the stream-less row, which the pace dial
	// never carries and this function never reads — five wasted document reads on
	// a path a walker hop takes every time it asks for its day budget. The reads
	// are independent, so they go out together rather than one round trip at a
	// time.
	const rows = await Promise.all(
		cells.map((cell) =>
			ctx.db
				.query('deliverabilityRouteStates')
				.withIndex('by_org_provider_stream', (q) =>
					q
						.eq('organizationId', args.organizationId)
						.eq('destinationProvider', cell.destinationProvider)
						.eq('stream', cell.stream)
				)
				.first()
		)
	);

	let smallest = PACE_INITIAL_MULTIPLIER;
	for (const row of rows) {
		const stored = row?.paceMultiplier;
		// An absent dial is the published schedule, unmodified; an unreadable one
		// is not a reason to slow a deployment down (plan D2).
		if (stored === undefined || !Number.isFinite(stored) || stored <= 0) continue;
		smallest = Math.min(smallest, stored);
	}
	return smallest;
}

/**
 * Apply a pace multiplier to a per-day capacity projection.
 *
 * A projected ZERO stays zero — it is a real reading that the day has no
 * capacity, and running it through the cap arithmetic (whose floor exists to
 * stop a quiet day pinning a cell near nothing) would manufacture capacity that
 * does not exist.
 */
export function applyPaceToCapacityByDay(byDay: readonly number[], multiplier: number): number[] {
	// ONLY THE RETREAT HALF OF THE DIAL REACHES PRODUCTION THROUGH HERE, and that
	// is a deliberate scope line rather than an oversight. Say it plainly so a
	// later piece cannot read `effectiveDailyCap`'s two separate caps and assume
	// the increase is already live:
	//
	//   · m < 1 (retreat) is applied HERE, to the pool-wide campaign projection —
	//     which is the campaign-facing cap Convex itself meters, so a retreat
	//     shortens today's slice on the very next walker hop.
	//   · m > 1 (increase) is NOT applied here and MUST NOT BE: the published base
	//     schedule is a HARD CEILING for the current day (plan D19) and this
	//     projection is stated in terms of it. The increase buys per-(IP x
	//     mailboxProvider) headroom BELOW that published cap, which lives in the
	//     MTA's own provider store — publishing the dial into that store is a NEW
	//     Convex -> MTA surface, and no piece on this branch owns it yet.
	//
	// Both caps are still passed separately below rather than collapsed, because
	// `effectiveDailyCap` is the one place the day's ceiling is applied and the
	// one place that distinction is allowed to be made.
	if (multiplier >= PACE_INITIAL_MULTIPLIER) return [...byDay];
	return byDay.map((cap) =>
		cap <= 0 ? 0 : effectiveDailyCap({ cellCap: cap, baseScheduleCap: cap, multiplier })
	);
}
