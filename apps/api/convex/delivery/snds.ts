/**
 * Microsoft SNDS storage and retention.
 *
 * The poller — fetching and fan-out — lives in the sibling `sndsPoll.ts`;
 * configuration parsing in `sndsConfig.ts` and feed parsing in `sndsFeed.ts`.
 * What remains here is the durable side: the idempotent ingest mutation and the
 * retention sweep.
 *
 * WHAT READS THE ROWS. `delivery/rampPromotionEvidence.ts`, and only it: the
 * `snds_band` promotion route asks for the newest green complaint band in the
 * window, over the same `by_period` index the sweep walks. There is no gate read
 * here — a `getMicrosoftGateInput` internalQuery and the pure gate beside it
 * shipped ahead of a controller that never consumed either, and both were
 * removed under D20 (issue #515) rather than given an invented caller.
 *
 * D2 — ADDITIVE ONLY. Nothing here throws on an absent enrolment: with no feed
 * configured the poller returns early, no row is ever written, and the Microsoft
 * cell runs on the `microsoft_snds` substitution the degradation matrix already
 * applies. SNDS can only lower measurement confidence and slow that cell's ramp,
 * never block it.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { sndsComplaintBandValidator, sndsFilterResultValidator } from '../schema/snds';
import { DAY_MS, normalizeSndsIp, type SndsDayObservation } from './sndsFeed';
import { oldestStorableDay } from './sndsConfig';
import { observationVerdict } from './observationFreshness';
import { type ObservationSweepResult, sweepExpiredObservations } from './observationRetention';

const RETENTION_MS = 90 * DAY_MS;
const FETCHED_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;

export const SNDS_CLEANUP_BATCH_SIZE = 128;

const observationValidator = v.object({
	ip: v.string(),
	periodStart: v.number(),
	complaintBand: sndsComplaintBandValidator,
	filterResult: sndsFilterResultValidator,
	trapHits: v.number(),
	messageRecipients: v.number(),
	rcptCommands: v.number(),
	dataCommands: v.number(),
	sampleHelo: v.optional(v.string()),
});

/** A counter that survived the wire: finite, non-negative, integral. */
function isNonNegativeSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function isStorableObservation(
	now: number,
	fetchedAt: number,
	observation: SndsDayObservation
): boolean {
	return (
		normalizeSndsIp(observation.ip) === observation.ip &&
		Number.isFinite(observation.periodStart) &&
		observation.periodStart % DAY_MS === 0 &&
		observation.periodStart <= now &&
		// DAY-ALIGNED, matching the poller's pre-filter exactly: every `periodStart`
		// is a UTC midnight, so an edge taken at `now` would sit mid-day and refuse
		// the oldest day the poller had just decided was worth a round trip.
		observation.periodStart >= oldestStorableDay(now) &&
		Number.isFinite(fetchedAt) &&
		fetchedAt >= observation.periodStart &&
		fetchedAt <= now + FETCHED_AT_FUTURE_TOLERANCE_MS &&
		isNonNegativeSafeInteger(observation.trapHits) &&
		isNonNegativeSafeInteger(observation.messageRecipients) &&
		isNonNegativeSafeInteger(observation.rcptCommands) &&
		isNonNegativeSafeInteger(observation.dataCommands)
	);
}

/**
 * Store a batch of (IP, day) observations idempotently.
 *
 * Freshness is arbitrated exactly as the Postmaster path does it: a newer read
 * replaces the row, an identical read is an acknowledged replay, an older one
 * is refused. `replace`, not `patch`, so a value the feed stops reporting
 * disappears instead of lingering.
 *
 * BATCHING IS THE CALLER'S CONTRACT. `sndsPoll.poll` slices at
 * `SNDS_INGEST_BATCH_SIZE` before it calls, and it is the only caller. A second
 * cap here would be a seam with no user (D20) and — since the argument validator
 * cannot bound an array's length — it would not protect the transaction from a
 * large argument anyway, only from a large loop.
 */
export const ingestDays = internalMutation({
	args: { observations: v.array(observationValidator), fetchedAt: v.number() },
	handler: async (ctx, args) => {
		const now = Date.now();
		let ingested = 0;
		let rejected = 0;
		let replayed = 0;
		for (const observation of args.observations) {
			if (!isStorableObservation(now, args.fetchedAt, observation)) {
				rejected += 1;
				continue;
			}
			const existing = await ctx.db
				.query('sndsIpDailyStats')
				.withIndex('by_ip_period', (q) =>
					q.eq('ip', observation.ip).eq('periodStart', observation.periodStart)
				)
				.unique();
			const verdict = observationVerdict(existing?.fetchedAt, args.fetchedAt);
			if (verdict !== 'write') {
				if (verdict === 'replayed') replayed += 1;
				else rejected += 1;
				continue;
			}
			// Spread the validated observation: it IS the row's shape, so respelling
			// its eight fields here would be a fourth place to keep them in step.
			const values = { ...observation, fetchedAt: args.fetchedAt, ingestedAt: now };
			if (existing) await ctx.db.replace(existing._id, values);
			else await ctx.db.insert('sndsIpDailyStats', values);
			ingested += 1;
		}
		// `rejected` counts refusals, not failures: the caller logs a number, and
		// nothing here throws, because the feed is internet-supplied input.
		return { ingested, rejected, replayed };
	},
});

/**
 * The return type is ANNOTATED, not inferred, and that annotation is load-bearing.
 *
 * `scheduleContinuation` names this very mutation through the generated API, so
 * an inferred handler return type would have to resolve `internal.delivery.snds.cleanup`
 * in order to type the argument it is being inferred from. TypeScript answers
 * that circularity with `any`, which then propagates through `fullApi` and
 * collapses `ctx.db` inference across the whole app. Stating the type cuts the
 * cycle at its only load-bearing edge.
 */
export const cleanup = internalMutation({
	args: {},
	handler: async (ctx): Promise<ObservationSweepResult> =>
		sweepExpiredObservations(ctx, {
			now: Date.now(),
			retentionMs: RETENTION_MS,
			batchSize: SNDS_CLEANUP_BATCH_SIZE,
			scans: [
				(horizon, limit) =>
					ctx.db
						.query('sndsIpDailyStats')
						.withIndex('by_period', (q) => q.lt('periodStart', horizon))
						.take(limit),
			],
			scheduleContinuation: () => ctx.scheduler.runAfter(0, internal.delivery.snds.cleanup, {}),
		}),
});
