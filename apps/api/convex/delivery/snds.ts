/**
 * Microsoft SNDS storage, retention and gate input.
 *
 * The poller — fetching and fan-out — lives in the sibling `sndsPoll.ts`;
 * configuration parsing in `sndsConfig.ts`, feed parsing in `sndsFeed.ts`, and
 * the decision in `signals/snds.ts` beside the other provider signal sources.
 * What remains here is the durable side: the idempotent ingest mutation, the
 * retention sweep, and the bounded read that gate 3 consumes.
 *
 * D2 — ADDITIVE ONLY. Nothing here throws on an absent enrolment: the gate read
 * answers `available: false` with the documented substitution, and SNDS can only
 * lower measurement confidence and slow the Microsoft cell's ramp, never block it.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { internalMutation, internalQuery, type QueryCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import { sndsComplaintBandValidator, sndsFilterResultValidator } from '../schema/snds';
import { DAY_MS, normalizeSndsIp, type SndsDayObservation } from './sndsFeed';
import { buildSndsGateInput, type SndsGateInput, type SndsGateObservation } from './signals/snds';
import { oldestStorableDay, parsePoolAllowlist, parseSndsFeedUrls } from './sndsConfig';
import { observationVerdict } from './observationFreshness';
import { type ObservationSweepResult, sweepExpiredObservations } from './observationRetention';

const RETENTION_MS = 90 * DAY_MS;
const FETCHED_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;

export const SNDS_CLEANUP_BATCH_SIZE = 128;
/** How many stored days one UNSCOPED gate evaluation may read. */
export const SNDS_GATE_MAX_ROWS = 512;
/**
 * How many declared pool addresses one gate evaluation walks, and how many days
 * it reads for each. A pool-scoped read is bounded by the pool rather than by
 * the table, so it never reports `truncated` merely for having a lot of history:
 * the per-IP cap is comfortably above the 90-day retention ceiling.
 */
export const SNDS_GATE_MAX_POOL_IPS = 64;
export const SNDS_GATE_MAX_ROWS_PER_IP = 96;
export const SNDS_GATE_WINDOW_DAYS = 7;

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

/**
 * Gate 3's input for the Microsoft cell.
 *
 * Returns `available: false` with the documented substitution when the
 * operator never enrolled OR when the window is empty — the caller treats both
 * the same way, which is the point of the substitution table.
 *
 * THE READ IS SCOPED THE WAY THE INGEST IS SCOPED. An SNDS key is issued per
 * REGISTERED RANGE, so the table can legitimately hold days belonging to other
 * senders in that range — the poller only drops them when the operator has
 * declared `MTA_IP_POOLS`, and rows ingested before they declared it stay for
 * the full retention. Folding those in would let a neighbour's clean band
 * satisfy OUR promotion criterion, because the worst-of fold only protects the
 * DOWN direction. So: with a declared pool the query walks the pool and reads
 * nothing else; with no declared pool the window is read whole but marked
 * UNATTRIBUTED, which caps confidence at `low` and makes promotion impossible
 * while leaving pass/fail — and therefore every ability to slow the ramp —
 * exactly as it was. D2 holds: nothing here blocks, errors or nags.
 */
export const getMicrosoftGateInput = internalQuery({
	args: { windowDays: v.optional(v.number()) },
	handler: async (ctx, args): Promise<SndsGateInput> => {
		const windowDays =
			args.windowDays !== undefined && Number.isFinite(args.windowDays) && args.windowDays > 0
				? Math.min(Math.floor(args.windowDays), 90)
				: SNDS_GATE_WINDOW_DAYS;
		const enrolled = parseSndsFeedUrls(getOptional('SNDS_DATA_FEED_URLS')).length > 0;
		if (!enrolled) {
			return buildSndsGateInput({
				enrolled,
				windowDays,
				observations: [],
				truncated: false,
				attributed: false,
			});
		}

		const window = await readGateRows(ctx, {
			pool: [...parsePoolAllowlist(getOptional('MTA_IP_POOLS'))].sort(),
			cutoff: Date.now() - windowDays * DAY_MS,
		});
		// ONE build, ONE argument set. The two read shapes differ in HOW they walk
		// the table, never in which disqualifiers they declare.
		return buildSndsGateInput({ enrolled, windowDays, ...window });
	},
});

/**
 * Read the gate window, either pool-scoped or whole.
 *
 * Both shapes read NEWEST FIRST. The read is capped, and an ascending scan
 * spends the cap on the OLDEST days — so a red filter result recorded today is
 * exactly the row that falls off the end, and the gate would answer `pass` from
 * a window that no longer contains the breach. Descending keeps today's evidence
 * inside the cap, and `truncated` then tells the gate that what it did NOT see
 * must never be read as cleanliness.
 */
async function readGateRows(
	ctx: QueryCtx,
	args: { pool: readonly string[]; cutoff: number }
): Promise<{ observations: SndsGateObservation[]; truncated: boolean; attributed: boolean }> {
	const observations: SndsGateObservation[] = [];
	if (args.pool.length === 0) {
		const rows = await ctx.db
			.query('sndsIpDailyStats')
			.withIndex('by_period', (q) => q.gte('periodStart', args.cutoff))
			.order('desc')
			.take(SNDS_GATE_MAX_ROWS);
		for (const row of rows) observations.push(projectGateObservation(row));
		return { observations, truncated: rows.length >= SNDS_GATE_MAX_ROWS, attributed: false };
	}

	// A pool larger than this reads as truncated rather than as a long query:
	// the window is then a subset, which the gate already knows how to hold.
	let truncated = args.pool.length > SNDS_GATE_MAX_POOL_IPS;
	for (const ip of args.pool.slice(0, SNDS_GATE_MAX_POOL_IPS)) {
		const rows = await ctx.db
			.query('sndsIpDailyStats')
			.withIndex('by_ip_period', (q) => q.eq('ip', ip).gte('periodStart', args.cutoff))
			.order('desc')
			.take(SNDS_GATE_MAX_ROWS_PER_IP);
		if (rows.length >= SNDS_GATE_MAX_ROWS_PER_IP) truncated = true;
		for (const row of rows) observations.push(projectGateObservation(row));
	}
	return { observations, truncated, attributed: true };
}

/**
 * Narrow a stored row to what the gate reads.
 *
 * It takes the ROW TYPE, not a structural literal that re-spells the row's
 * fields: a schema rename should be a compile error here rather than a silent
 * drift into a projection nothing populates any more.
 */
function projectGateObservation(row: Doc<'sndsIpDailyStats'>): SndsGateObservation {
	return {
		ip: row.ip,
		periodStart: row.periodStart,
		complaintBand: row.complaintBand,
		filterResult: row.filterResult,
		trapHits: row.trapHits,
	};
}
