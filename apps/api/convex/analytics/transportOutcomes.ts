/**
 * Transport outcomes — per-cell, per-arm rolling counters (plan D5, ADR-0042).
 *
 * The shipped delivery stack measures ACCEPTANCE: a transport took the message,
 * so the send is a success. A message Gmail accepts and files into Spam is
 * therefore indistinguishable from one that landed in the inbox (plan G-05).
 * This module is the counter half of the fix: it records what actually HAPPENED
 * to a message — delivered, deferred, bounced, complained, opened, clicked —
 * against the CELL and the ARM the recipient was assigned to, so the ramp
 * controller can compare "our own MTA" with "the reference transport" instead of
 * comparing nothing.
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
 * WHAT FEEDS IT: the SHIPPED Send lifecycle. `delivery/sendLifecycle.ts` emits a
 * `transport_outcome` effect for every non-duplicate transition and the existing
 * effect runner applies it. There is no parallel event stream, and no existing
 * effect changed what it does.
 *
 * WHAT IS EXCLUDED: anything with no `sendAssignments` row records NOTHING. That
 * is the seam seed shadow copies rely on (plan D18 — a seed probe is a shadow
 * copy through the identical composer and transport, NOT audience membership, so
 * it never gets an assignment row and can never enter a denominator here).
 * Transactional `test` sends are excluded one layer up, by the lifecycle's
 * existing `withoutTestSendEffects`.
 */

import { v } from 'convex/values';
import {
	internalMutation,
	internalQuery,
	type DatabaseReader,
	type MutationCtx,
} from '../_generated/server';
import { internal } from '../_generated/api';
import { parseDeliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { logWarn } from '../lib/runtimeLog';
import { startOfDayUtc } from './sendingReputation';
import {
	safeOutcomeCount,
	summarizeTransportOutcomeBuckets,
	transportOutcomeCounters,
	transportOutcomeWindowBounds,
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

// ============ CONSTANTS ============

/**
 * Write-shard count per (org, cell, arm, day) bucket — the same knob, for the
 * same reason, as `sendingReputation`'s. Each event bumps one random shard, so a
 * blast spreads its read-modify-writes across 8 documents instead of contending
 * on one. Purely write-side: the summarizer sums across all shards.
 */
export const TRANSPORT_OUTCOME_SHARD_COUNT = 8;

/** Buckets age out after 90 days — the `sendAssignments` retention horizon. */
export const TRANSPORT_OUTCOME_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Rows deleted per aging tick; the sweep re-schedules itself while full. */
export const TRANSPORT_OUTCOME_CLEANUP_BATCH_SIZE = 200;

// ============ READ SIDE ============

export interface CellArmWindowQuery extends TransportOutcomeWindow {
	readonly organizationId: string;
	readonly cell: string;
	readonly arm: TransportOutcomeArm;
}

/**
 * Read one (org, cell, arm) window's shard rows. Org-leading and bounded: the
 * aging cron keeps a cell/arm at ≤90 days × SHARD_COUNT rows, and the day range
 * narrows it further.
 */
async function readCellArmBuckets(
	db: DatabaseReader,
	input: CellArmWindowQuery
): Promise<TransportOutcomeBucket[]> {
	const { sinceDay, until } = transportOutcomeWindowBounds(input);
	// One range expression, not a branch per bound: an unbounded side becomes a
	// sentinel no real bucket day can fall outside of (`periodStart` is always a
	// finite UTC day timestamp). The exact window filter is re-applied by the
	// pure summarizer, so a sentinel can never widen the answer.
	const lower = Number.isFinite(sinceDay) ? sinceDay : 0;
	const upper = Number.isFinite(until) ? until : Number.MAX_SAFE_INTEGER;
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
 * Both arms of one cell over the same window — the shape every arm comparison
 * (the ramp controller's gates, the dashboard) actually wants. Two bounded
 * index reads through the one summarizer; never a cross-arm scan.
 */
export async function summarizeTransportOutcomeArms(
	db: DatabaseReader,
	input: TransportOutcomeWindow & { readonly organizationId: string; readonly cell: string }
): Promise<{ own: TransportOutcomeSummary; reference: TransportOutcomeSummary }> {
	const own = await summarizeTransportOutcomes(db, { ...input, arm: 'own' });
	const reference = await summarizeTransportOutcomes(db, { ...input, arm: 'reference' });
	return { own, reference };
}

/**
 * Org-scoped, window-bounded cell summary — the seam the ramp controller and the
 * delivery dashboard read through, so both see one derivation of one number.
 */
export const getCellOutcomeSummary = internalQuery({
	args: {
		organizationId: v.string(),
		cell: v.string(),
		since: v.optional(v.number()),
		until: v.optional(v.number()),
	},
	handler: async (ctx, args) =>
		await summarizeTransportOutcomeArms(ctx.db, {
			organizationId: args.organizationId,
			cell: args.cell,
			...(args.since !== undefined ? { since: args.since } : {}),
			...(args.until !== undefined ? { until: args.until } : {}),
		}),
});

// ============ WRITER (the hot path) ============

interface BucketKey {
	readonly organizationId: string;
	readonly cell: string;
	readonly arm: TransportOutcomeArm;
	readonly periodStart: number;
	readonly shardKey: number;
}

/**
 * Today's shard row for a (org, cell, arm) bucket, created on the first event
 * that lands on it. Every index component is pinned, so this is a point read.
 */
async function outcomeShardBucket(
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

export interface RecordTransportOutcomeInput {
	readonly organizationId: string;
	readonly cell: string;
	readonly arm: TransportOutcomeArm;
	readonly event: TransportOutcomeEvent;
	readonly isCalibration: boolean;
	readonly now?: number;
}

/**
 * Bump ONE random shard of the (org, cell, arm, today) bucket by ONE event.
 * The shard is drawn per call so concurrent events for the same cell spread
 * across `TRANSPORT_OUTCOME_SHARD_COUNT` documents instead of contending on a
 * single row. (Mutations may use `Math.random`; only the workflow runtime
 * forbids it.)
 */
export async function recordTransportOutcomeForCell(
	ctx: MutationCtx,
	input: RecordTransportOutcomeInput
): Promise<void> {
	const now = input.now !== undefined && Number.isFinite(input.now) ? input.now : Date.now();
	const bucket = await outcomeShardBucket(
		ctx,
		{
			organizationId: input.organizationId,
			cell: input.cell,
			arm: input.arm,
			periodStart: startOfDayUtc(now),
			shardKey: Math.floor(Math.random() * TRANSPORT_OUTCOME_SHARD_COUNT),
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
export type RecordTransportOutcomeResult =
	| 'recorded'
	| 'no_organization'
	| 'no_assignment'
	| 'invalid_cell';

/**
 * The lifecycle entry point: learn (cell, arm, isCalibration) by joining the
 * send to its `sendAssignments` row, then bump one shard.
 *
 * FAIL-SOFT BY CONSTRUCTION. A send with no assignment row — a seed shadow copy
 * (plan D18), a send enqueued before this pipeline existed, a recipient whose
 * cell could not be named — records NOTHING and returns a reason. Measurement
 * degrades; delivery never does.
 */
export async function recordTransportOutcomeForSend(
	ctx: MutationCtx,
	input: { readonly sendId: string; readonly event: TransportOutcomeEvent; readonly now?: number }
): Promise<RecordTransportOutcomeResult> {
	let organizationId: string;
	try {
		organizationId = await getSingletonOrganizationId(ctx);
	} catch {
		return 'no_organization';
	}

	const assignment = await ctx.db
		.query('sendAssignments')
		.withIndex('by_org_send', (q) =>
			q.eq('organizationId', organizationId).eq('sendId', input.sendId)
		)
		.first();
	// No assignment row ⇒ this send is outside the experiment (seed shadow
	// copies, legacy sends). It must never enter a denominator.
	if (!assignment) return 'no_assignment';
	// `cell` is a plain string in the schema; a malformed one would create a
	// bucket no reader can ever address.
	if (parseDeliverabilityCellKey(assignment.cell) === null) return 'invalid_cell';

	await recordTransportOutcomeForCell(ctx, {
		organizationId,
		cell: assignment.cell,
		arm: assignment.arm,
		event: input.event,
		isCalibration: assignment.isCalibration,
		...(input.now !== undefined ? { now: input.now } : {}),
	});
	return 'recorded';
}

/**
 * Applied by the Send lifecycle's effect runner. Recording an outcome must never
 * be able to fail a delivery state transition, so every failure degrades to a
 * warning and the transition proceeds untouched.
 */
export async function applyTransportOutcomeEffect(
	ctx: MutationCtx,
	effect: { readonly sendId: string; readonly event: TransportOutcomeEvent; readonly at: number }
): Promise<void> {
	try {
		await recordTransportOutcomeForSend(ctx, {
			sendId: effect.sendId,
			event: effect.event,
			now: effect.at,
		});
	} catch (error) {
		// Never the recipient address: an outcome log line must not become a PII
		// sink. The event name is enough to tell a systematic failure apart.
		logWarn(
			`[transportOutcomes] failed to record ${effect.event} outcome:`,
			error instanceof Error ? error.name : 'UnknownError'
		);
	}
}

// ============ AGING CRON ============

/**
 * Drop buckets past the retention horizon. Indexed, bounded and self-resuming,
 * so a backlog drains across ticks instead of blowing one transaction — the same
 * sweep shape as the `sendAssignments` retention cron.
 */
export const cleanupExpiredOutcomes = internalMutation({
	args: { now: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const now = args.now !== undefined && Number.isFinite(args.now) ? args.now : Date.now();
		const cutoff = now - TRANSPORT_OUTCOME_RETENTION_MS;
		const expired = await ctx.db
			.query('transportOutcomes')
			.withIndex('by_period_start', (q) => q.lt('periodStart', cutoff))
			.take(TRANSPORT_OUTCOME_CLEANUP_BATCH_SIZE);
		await Promise.all(expired.map((row) => ctx.db.delete(row._id)));
		if (expired.length === TRANSPORT_OUTCOME_CLEANUP_BATCH_SIZE) {
			await ctx.scheduler.runAfter(
				0,
				internal.analytics.transportOutcomes.cleanupExpiredOutcomes,
				args
			);
		}
		return { deleted: expired.length };
	},
});
