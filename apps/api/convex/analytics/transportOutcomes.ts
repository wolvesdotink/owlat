/**
 * Transport outcomes — per-cell, per-arm rolling counters (ADR-0042).
 *
 * The shipped delivery stack measures ACCEPTANCE: a transport took the message,
 * so the send is a success. A message Gmail accepts and files into Spam is
 * therefore indistinguishable from one that landed in the inbox. This module is
 * the counter half of the fix: it records what actually HAPPENED to a message —
 * delivered, deferred, bounced, complained, opened, clicked — against the CELL
 * and the ARM the recipient was assigned to, so the ramp controller can compare
 * "our own MTA" with "the reference transport" instead of comparing nothing.
 *
 * The shape is copied from `analytics/sendingReputation.ts` on purpose:
 *
 *   - ONE WRITER on the hot path (`recordTransportOutcomeForSend`). It joins the
 *     send to its `sendAssignments` row to learn (cell, arm, isCalibration),
 *     then bumps ONE RANDOM SHARD of the (org, cell, arm, day) bucket. Two
 *     indexed point reads and one patch — no window scan, no `.collect()` (the
 *     ADR-0042 post-mortem).
 *   - ONE READER-TYPED SUMMARIZER (`summarizeTransportOutcomes`) that sums
 *     ACROSS shards, so the shard split is invisible to readers, and derives
 *     every rate ON READ through the pure core in `./transportOutcomeSummary`.
 *     `DatabaseReader`-typed, so it runs unchanged in query and mutation ctx and
 *     the controller and the dashboard cannot disagree about a number.
 *   - NO RATE IS EVER STORED. If you find yourself adding a `bounceRate` column
 *     or a second place a rate is computed, stop: that is the defect this whole
 *     module exists to prevent.
 *   - AN AGING CRON (`cleanupExpiredOutcomes`) drops buckets past the retention
 *     horizon, so the per-cell read set stays bounded.
 *
 * The shard count, retention horizon, window range and send → (cell, arm) join
 * are shared with `analytics/smtpResponseCategories.ts` through
 * `./cellArmBuckets`; this module owns only what a transport outcome counts.
 *
 * WHAT FEEDS IT: the SHIPPED Send lifecycle. `delivery/sendLifecycle.ts` emits a
 * `transport_outcome` effect for every non-duplicate delivery transition, and
 * the `opened`/`clicked` twins are emitted by the reducers themselves from
 * inside the shipped UNIQUE-open/click gate, so an outcome counter always means
 * the same thing as the dashboard counter next to it. The existing effect runner
 * applies both. There is no parallel event stream, and no existing effect
 * changed what it does.
 *
 * TWO events have no lifecycle transition to ride, and only two. `unsubscribed`
 * arrives on a public CONTACT-keyed endpoint carrying no send id at all, so
 * `delivery/unsubscribeOutcome.ts` does the contact → send join and pushes the
 * effect through this same runner, under a per-send uniqueness gate of its own.
 * `deferred` has the send id but no transition: a deferred message stays
 * `queued` — that is what a deferral IS — so `delivery/deferralOutcome.ts`
 * records it from the completion callback, under a per-send, per-DAY gate
 * (a held send is re-enqueued many times and must be counted once).
 * It is still ONE writer; what differs is who supplies the send id.
 *
 * WHAT IS EXCLUDED: anything with no `sendAssignments` row records NOTHING. That
 * is the seam seed shadow copies rely on (a seed probe is a shadow copy through
 * the identical composer and transport, NOT audience membership, so it never
 * gets an assignment row and can never enter a denominator here). Transactional
 * `test` sends are excluded one layer up, by the lifecycle's existing
 * `withoutTestSendEffects`.
 */

import { v } from 'convex/values';
import { literalUnion } from '../lib/literalUnion';
import type { DatabaseReader, MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { DeliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import { logWarn } from '../lib/runtimeLog';
import { resolveNow, utcDayStart } from '../lib/clock';
import { type ObservationSweepResult, sweepExpiredObservations } from '../lib/retentionSweep';
import {
	CELL_ARM_BUCKET_CLEANUP_BATCH_SIZE,
	CELL_ARM_BUCKET_RETENTION_MS,
	cellArmPeriodRange,
	randomCellArmShardKey,
	resolveCellArmForSend,
	type CellArmWindowQuery,
} from './cellArmBuckets';
import {
	safeOutcomeCount,
	summarizeTransportOutcomeBuckets,
	transportOutcomeCounters,
	TRANSPORT_OUTCOME_EVENTS,
	ZERO_TRANSPORT_OUTCOME_TOTALS,
	type TransportOutcomeArm,
	type TransportOutcomeBucket,
	type TransportOutcomeCounter,
	type TransportOutcomeEvent,
	type TransportOutcomeSummary,
	type TransportOutcomeWindow,
} from './transportOutcomeSummary';

// The pure core is the module's public vocabulary too — callers import the
// event type from the module they call, not from its internals.
export type {
	TransportOutcomeArm,
	TransportOutcomeBucket,
	TransportOutcomeEvent,
	TransportOutcomeSummary,
} from './transportOutcomeSummary';

// ============ READ SIDE ============

/**
 * Read one (org, cell, arm) window's shard rows. Org-leading and bounded: the
 * aging cron keeps a cell/arm at ≤90 days × SHARD_COUNT rows, and the day range
 * narrows it further.
 *
 * Exported for the ONE consumer that needs the rows rather than a single
 * summary: the deliverability dashboard derives several disjoint sub-windows
 * (the evaluation window, the trailing baseline, one point per day of trend)
 * from one read, and re-runs `summarizeTransportOutcomeBuckets` over each. That
 * keeps the derive-on-read rule intact — every rate it shows still comes out of
 * the one summarizer — while costing one index read per (cell, arm) instead of
 * one per sub-window. Do NOT sum these rows by hand anywhere.
 */
export async function readCellArmBuckets(
	db: DatabaseReader,
	input: CellArmWindowQuery
): Promise<TransportOutcomeBucket[]> {
	const { lower, upper } = cellArmPeriodRange(input);
	return await db
		.query('transportOutcomes')
		.withIndex('by_org_cell_arm_period_shard', (q) =>
			q
				.eq('organizationId', input.organizationId)
				.eq('cell', input.cell)
				.eq('arm', input.arm)
				.gte('periodStart', lower)
				.lt('periodStart', upper)
		)
		.collect(); // bounded: one cell/arm's ≤90-day × shard buckets (cron-pruned)
}

/**
 * THE summarizer. Reader-typed (`DatabaseReader`), so a query shell, a mutation
 * and the controller cron all derive the identical number from the identical
 * code — the shard split and the derive-on-read rule stay invisible and
 * unbypassable.
 */
export async function summarizeTransportOutcomes(
	db: DatabaseReader,
	input: CellArmWindowQuery
): Promise<TransportOutcomeSummary> {
	return summarizeTransportOutcomeBuckets(await readCellArmBuckets(db, input), input);
}

/**
 * Both arms of one cell over ONE window — the shape the ramp controller's gates
 * want. Two bounded index reads through the one summarizer; never a cross-arm
 * scan.
 *
 * NOT for a caller that needs SEVERAL windows over the same rows: the delivery
 * dashboard derives an evaluation window, a trailing baseline and a per-day
 * trend from the same traffic, so it reads the rows ONCE via
 * `readCellArmBuckets` and re-runs `summarizeTransportOutcomeBuckets` over each
 * window. That is still exactly one derivation of one number — the summarizer —
 * which is the invariant this module protects; what it avoids is re-reading the
 * same index thirty times per cell.
 */
export async function summarizeTransportOutcomeArms(
	db: DatabaseReader,
	input: TransportOutcomeWindow & {
		readonly organizationId: string;
		readonly cell: DeliverabilityCellKey;
	}
): Promise<{ own: TransportOutcomeSummary; reference: TransportOutcomeSummary }> {
	const own = await summarizeTransportOutcomes(db, { ...input, arm: 'own' });
	const reference = await summarizeTransportOutcomes(db, { ...input, arm: 'reference' });
	return { own, reference };
}

// ============ WRITER (the hot path) ============

interface BucketKey {
	readonly organizationId: string;
	readonly cell: DeliverabilityCellKey;
	readonly arm: TransportOutcomeArm;
	readonly periodStart: number;
	readonly shardKey: number;
}

/**
 * Today's shard row for a (org, cell, arm) bucket, CREATED on the first event
 * that lands on it — hence `ensure`, not a getter. Every index component is
 * pinned, so the lookup is a point read.
 */
async function ensureOutcomeShardBucket(
	ctx: MutationCtx,
	key: BucketKey,
	now: number
): Promise<TransportOutcomeBucket> {
	const existing = await ctx.db
		.query('transportOutcomes')
		.withIndex('by_org_cell_arm_period_shard', (q) =>
			q
				.eq('organizationId', key.organizationId)
				.eq('cell', key.cell)
				.eq('arm', key.arm)
				.eq('periodStart', key.periodStart)
				.eq('shardKey', key.shardKey)
		)
		.unique();
	if (existing) return existing;

	const id = await ctx.db.insert('transportOutcomes', {
		organizationId: key.organizationId,
		cell: key.cell,
		arm: key.arm,
		periodStart: key.periodStart,
		shardKey: key.shardKey,
		...ZERO_TRANSPORT_OUTCOME_TOTALS,
		lastRecordedAt: now,
	});
	const created = await ctx.db.get(id);
	if (!created) throw new Error('Failed to create transport outcome bucket');
	return created;
}

interface RecordTransportOutcomeInput {
	readonly organizationId: string;
	readonly cell: DeliverabilityCellKey;
	readonly arm: TransportOutcomeArm;
	readonly event: TransportOutcomeEvent;
	readonly isCalibration: boolean;
	readonly now?: number;
}

/**
 * Bump ONE random shard of the (org, cell, arm, today) bucket by ONE event.
 * The shard is drawn per call so concurrent events for the same cell spread
 * across `CELL_ARM_BUCKET_SHARD_COUNT` documents instead of contending on a
 * single row.
 */
export async function recordTransportOutcomeForCell(
	ctx: MutationCtx,
	input: RecordTransportOutcomeInput
): Promise<void> {
	const now = resolveNow(input.now);
	const bucket = await ensureOutcomeShardBucket(
		ctx,
		{
			organizationId: input.organizationId,
			cell: input.cell,
			arm: input.arm,
			periodStart: utcDayStart(now),
			shardKey: randomCellArmShardKey(),
		},
		now
	);
	const patch: { [K in TransportOutcomeCounter]?: number } = {};
	for (const counter of transportOutcomeCounters(input.event, input.isCalibration)) {
		patch[counter] = safeOutcomeCount(bucket[counter]) + 1;
	}
	await ctx.db.patch(bucket._id, { ...patch, lastRecordedAt: now });
}

/** Why an outcome was not recorded — returned, never thrown. */
type RecordTransportOutcomeResult =
	| 'recorded'
	| 'no_organization'
	| 'no_assignment'
	| 'invalid_cell';

/**
 * The lifecycle entry point: learn (cell, arm, isCalibration) by joining the
 * send to its `sendAssignments` row, then bump one shard.
 *
 * FAIL-SOFT BY CONSTRUCTION. A send with no assignment row — a seed shadow copy, a send enqueued
 * before this pipeline existed, a recipient whose cell could not be named — records NOTHING and
 * returns a reason. Measurement degrades; delivery never does.
 */
export async function recordTransportOutcomeForSend(
	ctx: MutationCtx,
	input: { readonly sendId: string; readonly event: TransportOutcomeEvent; readonly now?: number }
): Promise<RecordTransportOutcomeResult> {
	const resolved = await resolveCellArmForSend(ctx, input.sendId);
	if (!resolved.ok) return resolved.reason;

	await recordTransportOutcomeForCell(ctx, {
		organizationId: resolved.organizationId,
		cell: resolved.cell,
		arm: resolved.arm,
		event: input.event,
		isCalibration: resolved.isCalibration,
		...(input.now !== undefined ? { now: input.now } : {}),
	});
	return 'recorded';
}

/** Derived from the vocabulary, never re-spelled: one list, one wire contract. */
const transportOutcomeEventValidator = literalUnion(TRANSPORT_OUTCOME_EVENTS);

/**
 * The Send lifecycle's `transport_outcome` effect, SCHEDULED off the transition
 * rather than applied inside it — the same shape, for the same reason, as
 * `reputation_update`.
 *
 * The bump lands on one of `CELL_ARM_BUCKET_SHARD_COUNT` shards of a bucket
 * that every recipient of the same cell writes to on the same day. Applied
 * inline, an OCC conflict on that shard retries the ENTIRE delivery transaction
 * — the send patch, the campaign counters, the daily stats, the webhook fanout —
 * during exactly the open waves that make the conflict likely. Scheduled, the
 * retry is confined to this one narrow write. The outcome has no claim on the
 * transition's atomicity: it is fail-soft by design (below), so a lost bump
 * already degrades measurement rather than delivery either way.
 *
 * Recording an outcome must never be able to fail the transaction it describes,
 * so every failure degrades to a warning.
 */
export const recordOutcomeForSend = internalMutation({
	args: {
		sendId: v.string(),
		event: transportOutcomeEventValidator,
		at: v.number(),
	},
	handler: async (ctx, args) => {
		try {
			await recordTransportOutcomeForSend(ctx, {
				sendId: args.sendId,
				event: args.event,
				now: args.at,
			});
		} catch (error) {
			// Never the recipient address: an outcome log line must not become a PII
			// sink. The event name is enough to tell a systematic failure apart.
			logWarn(
				`[transportOutcomes] failed to record ${args.event} outcome:`,
				error instanceof Error ? error.name : 'UnknownError'
			);
		}
	},
});

// ============ AGING CRON ============

/**
 * Drop buckets past the retention horizon. Indexed, bounded and self-resuming
 * through the shared `sweepExpiredObservations`, so a backlog drains across
 * ticks instead of blowing one transaction.
 */
export const cleanupExpiredOutcomes = internalMutation({
	args: { now: v.optional(v.number()) },
	handler: async (ctx, args): Promise<ObservationSweepResult> =>
		sweepExpiredObservations(ctx, {
			// A non-finite `now` would make the horizon NaN and the sweep a silent
			// no-op forever: `resolveNow` falls back to the real clock instead.
			now: resolveNow(args.now),
			retentionMs: CELL_ARM_BUCKET_RETENTION_MS,
			batchSize: CELL_ARM_BUCKET_CLEANUP_BATCH_SIZE,
			scans: [
				(horizon, limit) =>
					ctx.db
						.query('transportOutcomes')
						.withIndex('by_period_start', (q) => q.lt('periodStart', horizon))
						.take(limit),
			],
			scheduleContinuation: () =>
				ctx.scheduler.runAfter(
					0,
					internal.analytics.transportOutcomes.cleanupExpiredOutcomes,
					args
				),
		}),
});
