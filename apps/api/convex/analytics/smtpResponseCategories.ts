/**
 * SMTP response categories — per-cell, per-arm rolling counters (issue #501).
 *
 * THE MISSING HALF OF A CONTRACT THAT ALREADY EXISTED. `@owlat/shared/
 * smtpBlockCategories` has always named the vocabulary; the MTA has always
 * produced it (`classifySmtpResponse`); and the standalone ramp's gate-2 block
 * clause has always consumed it (`delivery/ramp/trailingBaselineGates.ts`,
 * `evaluateSmtpBlockMessages`). What did not exist was a row carrying the
 * verdict from one deployable to the other per (cell, arm), so the clause had a
 * reader and no producer and returned `null` on every tick of every deployment.
 * This module is that row's writer, its summarizer, and nothing else.
 *
 * ONE WRITER, on the ingress path. `smtp.classified` arrives on the MTA webhook
 * carrying a message id and a category — never a cell and never an arm, because
 * the MTA knows neither. `recordSmtpResponseForSend` resolves the send, joins it
 * through `sendAssignments` exactly as `analytics/transportOutcomes.ts` does, and
 * bumps ONE RANDOM SHARD of the (org, cell, arm, day) bucket. Two indexed point
 * reads and one patch — no window scan, no `.collect()` (ADR-0042).
 *
 * ONE READER-TYPED SUMMARIZER (`summarizeSmtpBlockObservation`), which sums
 * across shards so the split is invisible, and NO RATE ANYWHERE. The observation
 * it returns is counts plus an instant; the block RATE is derived once, by the
 * gate, so the controller and the dashboard cannot disagree about a number.
 *
 * ABSENCE IS NOT A ZERO, and that distinction is the entire reason this module
 * is careful. A window with no rows returns `null` — "we did not measure" — and
 * the gate holds its block clause, which is what it already did. A window with
 * rows and no refusals in them returns an observation whose block count is zero,
 * which is "we measured, and receivers are not refusing us". A summarizer that
 * collapsed the two would have turned every deployment on earth into a cell that
 * had affirmatively observed a clean SMTP conversation it never had.
 *
 * FAIL-SOFT, LIKE EVERY OTHER MEASUREMENT WRITE. A send with no assignment row —
 * a seed shadow copy (plan D18), a legacy send, a member preview — records
 * NOTHING and returns a reason. Measurement degrades; delivery never does.
 *
 * NOT EXACTLY-ONCE, and it does not need to be. The MTA's outbox retries a
 * failed delivery, so a response acknowledged after a partial failure can be
 * counted twice. That inflates numerator and denominator together, which moves
 * the derived block rate by a rounding error rather than toward a halt; the
 * shipped `smtpBlock` sample floor is what protects the verdict from a thin
 * window, in this direction as in every other.
 */

import { v } from 'convex/values';
import { internalMutation, type DatabaseReader, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import {
	deliverabilityCellKey,
	parseDeliverabilityCellKey,
	type DeliverabilityCellKey,
} from '@owlat/shared/deliverabilityRouting';
import {
	isSmtpFailureCategory,
	SMTP_FAILURE_CATEGORIES,
	type SmtpFailureCategory,
} from '@owlat/shared/smtpBlockCategories';
import type { Doc } from '../_generated/dataModel';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { logWarn } from '../lib/runtimeLog';
import { resolveNow, startOfDayUtc } from '../lib/clock';
import { readAssignmentForSend } from '../delivery/sendAssignments';
import { resolveProviderMessageId } from '../delivery/sendLifecycle/lookups';
import type { SmtpBlockObservation } from '../delivery/ramp/gateTypes';
import {
	safeOutcomeCount,
	transportOutcomeWindowBounds,
	type TransportOutcomeArm,
	type TransportOutcomeWindow,
} from './transportOutcomeSummary';

// ============ CONSTANTS ============

/**
 * Write-shard count per (org, cell, arm, day) bucket — the same knob, for the
 * same reason, as `transportOutcomes`'. One classified response bumps one random
 * shard, so a wave of greylisting spreads its read-modify-writes across 8
 * documents instead of contending on one. Purely write-side: the summarizer sums
 * across all shards.
 */
export const SMTP_RESPONSE_CATEGORY_SHARD_COUNT = 8;

/**
 * Buckets age out after 90 days — the `transportOutcomes` horizon, because the
 * two are read side by side over the same windows and a shorter one here would
 * make a cell's block evidence expire while the outcomes it is judged beside
 * remain.
 */
export const SMTP_RESPONSE_CATEGORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Rows deleted per aging tick; the sweep re-schedules itself while full. */
export const SMTP_RESPONSE_CATEGORY_CLEANUP_BATCH_SIZE = 200;

/**
 * THE BOUND ON HOW MANY DISTINCT CATEGORIES ONE SHARD ROW MAY CARRY: the whole
 * shared vocabulary, and not one key more.
 *
 * The stored field is `v.record(v.string(), v.number())`, so without a bound a
 * writer bug (or a vocabulary the two deployables disagree about) could grow a
 * row without limit. The writer narrows every incoming category through
 * `isSmtpFailureCategory` before it can reach a key, so this can only ever be
 * reached by the vocabulary itself growing — which is exactly when it should
 * grow, since it is derived from the vocabulary rather than hand-set.
 */
const MAX_CATEGORY_KEYS = SMTP_FAILURE_CATEGORIES.size;

// ============ READ SIDE ============

export interface SmtpCategoryWindowQuery extends TransportOutcomeWindow {
	readonly organizationId: string;
	readonly cell: DeliverabilityCellKey;
	readonly arm: TransportOutcomeArm;
}

/**
 * Read one (org, cell, arm) window's shard rows. Org-leading and bounded: the
 * aging cron keeps a cell/arm at <=90 days x SHARD_COUNT rows, and the day range
 * narrows it further.
 *
 * Exported as ROWS rather than as a summary for the same reason
 * `readCellArmBuckets` is: both production readers derive MORE THAN ONE window
 * from one read — the controller its 24-hour evaluation window out of the 30 days
 * it already reads for the engagement baseline, the dashboard its seven days out
 * of the same span — and a per-window read would cost the same index scan twice
 * for one answer. Do NOT sum these rows by hand anywhere; the summarizer below is
 * the only place that may.
 */
export async function readCellArmCategoryBuckets(
	db: DatabaseReader,
	input: SmtpCategoryWindowQuery
): Promise<Doc<'smtpResponseCategories'>[]> {
	const { sinceDay, until } = transportOutcomeWindowBounds(input);
	// One range expression, not a branch per bound: an unbounded side becomes a
	// sentinel no real bucket day can fall outside of. The exact window filter is
	// re-applied by the pure summarizer, so a sentinel can never widen the answer.
	const lower = Number.isFinite(sinceDay) ? sinceDay : 0;
	const upper = Number.isFinite(until) ? until : Number.MAX_SAFE_INTEGER;
	return await db
		.query('smtpResponseCategories')
		.withIndex('by_org_cell_arm_period_shard', (q) =>
			q
				.eq('organizationId', input.organizationId)
				.eq('cell', input.cell)
				.eq('arm', input.arm)
				.gte('periodStart', lower)
				.lt('periodStart', upper)
		)
		.collect(); // bounded: one cell/arm's <=90-day x shard buckets (cron-pruned)
}

/** The two fields the summarizer needs off a row — the pure core's own input. */
export interface SmtpCategoryBucket {
	readonly periodStart: number;
	readonly observed: number;
	readonly byCategory: Readonly<Record<string, number>>;
	readonly lastRecordedAt: number;
}

/**
 * Sum buckets (across ALL shards and days in the window) into the observation
 * gate 2's block clause reads — or `null` when the window contains no rows at
 * all.
 *
 * PURE — no clock, no database — so the reduction the controller and the
 * dashboard both depend on is exhaustively unit-testable, and so both of them
 * can run it over windows they read once and slice several ways.
 *
 * `null` IS NOT AN ERROR AND IT IS NOT A ZERO. It is the honest answer for a cell
 * whose receivers have said nothing classifiable inside the window — a cell that
 * sent nothing, a deployment whose MTA predates this telemetry, a window of
 * perfectly clean 250s. The gate reads absence as "no verdict from this clause"
 * and falls through to the deferral rate; it would read a zeroed observation as a
 * measured, thin sample. Those are different facts and this is the seam that
 * keeps them apart.
 *
 * THE COUNTS SPAN THE WHOLE WINDOW; THE STAMP IS THE NEWEST ROW, the same rule
 * `buildSeedPlacementSweeps` follows: anchoring the stamp on the oldest row would
 * make a cell answered every hour read as stale, which is the one thing a
 * freshness rule must not do. What ages out here is a cell that STOPPED
 * collecting responses.
 *
 * EVERY KEY IS NARROWED ONCE, HERE. The stored map is `v.record(v.string(), ...)`
 * and this is the row-read boundary, so `isSmtpFailureCategory` — the WHOLE
 * vocabulary, never the block subset, which would drop every rate-pressure
 * category the audit row exists to carry — runs on each key once per window
 * rather than on each element on every gate evaluation.
 */
export function summarizeSmtpBlockObservation(
	buckets: readonly SmtpCategoryBucket[],
	window?: TransportOutcomeWindow
): SmtpBlockObservation | null {
	const { sinceDay, until } = transportOutcomeWindowBounds(window);
	const blockedByCategory: Partial<Record<SmtpFailureCategory, number>> = {};
	let observed = 0;
	let observedAt: number | null = null;
	let rows = 0;

	for (const bucket of buckets) {
		if (!Number.isFinite(bucket.periodStart)) continue;
		if (bucket.periodStart < sinceDay || bucket.periodStart >= until) continue;
		rows += 1;
		observed += safeOutcomeCount(bucket.observed);
		const recordedAt = bucket.lastRecordedAt;
		if (
			Number.isFinite(recordedAt) &&
			(observedAt === null || (recordedAt as number) > observedAt)
		) {
			observedAt = recordedAt;
		}
		for (const [key, count] of Object.entries(bucket.byCategory ?? {})) {
			// A key outside the vocabulary is dropped rather than carried: the gate's
			// numerator sums the keys it recognises, so an unknown one would be an
			// invisible passenger in the denominator's row and nowhere else.
			if (!isSmtpFailureCategory(key)) continue;
			const safe = safeOutcomeCount(count);
			if (safe === 0) continue;
			blockedByCategory[key] = (blockedByCategory[key] ?? 0) + safe;
		}
	}

	// NO ROWS IS ABSENCE. A window whose rows all summed to zero is NOT — that
	// deployment answered, and `observedAt` is when it last did.
	if (rows === 0) return null;
	return { observed, blockedByCategory, observedAt: observedAt ?? 0 };
}

// ============ WRITER (the ingress path) ============

interface CategoryBucketKey {
	readonly organizationId: string;
	readonly cell: DeliverabilityCellKey;
	readonly arm: TransportOutcomeArm;
	readonly periodStart: number;
	readonly shardKey: number;
}

/**
 * Today's shard row for a (org, cell, arm) bucket, CREATED on the first response
 * that lands on it — hence `ensure`, not a getter. Every index component is
 * pinned, so the lookup is a point read.
 */
async function ensureCategoryShardBucket(
	ctx: MutationCtx,
	key: CategoryBucketKey,
	now: number
): Promise<Doc<'smtpResponseCategories'>> {
	const existing = await ctx.db
		.query('smtpResponseCategories')
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

	const id = await ctx.db.insert('smtpResponseCategories', {
		organizationId: key.organizationId,
		cell: key.cell,
		arm: key.arm,
		periodStart: key.periodStart,
		shardKey: key.shardKey,
		observed: 0,
		byCategory: {},
		lastRecordedAt: now,
	});
	const created = await ctx.db.get(id);
	if (!created) throw new Error('Failed to create SMTP response category bucket');
	return created;
}

export interface RecordSmtpResponseInput {
	readonly organizationId: string;
	readonly cell: DeliverabilityCellKey;
	readonly arm: TransportOutcomeArm;
	readonly category: SmtpFailureCategory;
	readonly now?: number;
}

/**
 * Bump ONE random shard of the (org, cell, arm, today) bucket by ONE classified
 * response. The shard is drawn per call so concurrent responses for the same cell
 * spread across `SMTP_RESPONSE_CATEGORY_SHARD_COUNT` documents instead of
 * contending on a single row. (Mutations may use `Math.random`; only the workflow
 * runtime forbids it.)
 *
 * `observed` AND the category counter MOVE TOGETHER, in one patch. They are the
 * denominator and the numerator of the one rate the gate derives, and a write
 * that could land one without the other is a write that can manufacture a block
 * rate above 1 — which `blockRate` is specifically written to distrust rather
 * than to clamp.
 */
export async function recordSmtpResponseForCell(
	ctx: MutationCtx,
	input: RecordSmtpResponseInput
): Promise<void> {
	const now = resolveNow(input.now);
	const bucket = await ensureCategoryShardBucket(
		ctx,
		{
			organizationId: input.organizationId,
			cell: input.cell,
			arm: input.arm,
			periodStart: startOfDayUtc(now),
			shardKey: Math.floor(Math.random() * SMTP_RESPONSE_CATEGORY_SHARD_COUNT),
		},
		now
	);
	const byCategory: Record<string, number> = { ...bucket.byCategory };
	// The bound can only be reached by the shared vocabulary growing, since the
	// caller's category is narrowed against it. A row already at the bound still
	// counts the response in `observed`: the sample is real evidence even when the
	// map cannot name what it was.
	if (
		byCategory[input.category] !== undefined ||
		Object.keys(byCategory).length < MAX_CATEGORY_KEYS
	) {
		byCategory[input.category] = safeOutcomeCount(byCategory[input.category]) + 1;
	}
	await ctx.db.patch(bucket._id, {
		observed: safeOutcomeCount(bucket.observed) + 1,
		byCategory,
		lastRecordedAt: now,
	});
}

/** Why a classified response was not recorded — returned, never thrown. */
export type RecordSmtpResponseResult =
	| 'recorded'
	| 'no_organization'
	| 'send_not_found'
	| 'no_assignment'
	| 'invalid_cell';

/**
 * The webhook entry point's core: resolve the MTA's message id to a send, learn
 * (cell, arm) from its `sendAssignments` row, then bump one shard.
 *
 * THE SAME JOIN EVERY OTHER TRANSPORT OUTCOME MAKES, on purpose. The arm is a
 * property of the assignment and of nothing else; deriving it from the fact that
 * our own MTA produced the response would be a second answer, and it would be
 * wrong the day a relay starts reporting classified responses of its own.
 */
export async function recordSmtpResponseForSend(
	ctx: MutationCtx,
	input: {
		readonly providerMessageId: string;
		readonly category: SmtpFailureCategory;
		readonly now?: number;
	}
): Promise<RecordSmtpResponseResult> {
	let organizationId: string;
	try {
		organizationId = await getSingletonOrganizationId(ctx);
	} catch {
		return 'no_organization';
	}

	const ref = await resolveProviderMessageId(ctx, input.providerMessageId);
	// A response for a message this deployment has no send row for — a probe, a
	// send already reaped, a replay from another install sharing the secret.
	if (!ref) return 'send_not_found';

	// THE tenant-scoped join, shared with every other reader of the row. No
	// assignment row => this send is outside the experiment (seed shadow copies,
	// legacy sends), and it must never enter a denominator.
	const assignment = await readAssignmentForSend(ctx.db, organizationId, ref.id);
	if (!assignment) return 'no_assignment';
	// `cell` is a plain string in the schema; a malformed one would create a
	// bucket no reader can ever address. Parse ONCE here and hand the branded,
	// re-canonicalized key down.
	const parsedCell = parseDeliverabilityCellKey(assignment.cell);
	if (parsedCell === null) return 'invalid_cell';

	await recordSmtpResponseForCell(ctx, {
		organizationId,
		cell: deliverabilityCellKey(parsedCell),
		arm: assignment.arm,
		category: input.category,
		...(input.now !== undefined ? { now: input.now } : {}),
	});
	return 'recorded';
}

/** Derived from the vocabulary, never re-spelled: one list, one wire contract. */
const smtpFailureCategoryValidator = v.union(
	...[...SMTP_FAILURE_CATEGORIES].map((category) => v.literal(category))
);

/**
 * The `smtp.classified` webhook's landing point.
 *
 * A WIRE BOUNDARY, so the validator is load-bearing: the category arrives as
 * dispatcher data, and this is the last thing holding it to the shared
 * vocabulary before it becomes a key in a stored map. Widened to `v.string()` it
 * would let a variant spelling create a key no reader narrows and no gate counts.
 *
 * Recording a response must never fail the webhook that reported it, so every
 * failure degrades to a warning: an unacknowledged event is one the MTA's outbox
 * will retry, and a measurement write is not worth a retry storm.
 */
export const recordClassifiedResponse = internalMutation({
	args: {
		providerMessageId: v.string(),
		category: smtpFailureCategoryValidator,
		observedAt: v.number(),
	},
	handler: async (ctx, args): Promise<{ result: RecordSmtpResponseResult }> => {
		try {
			return {
				result: await recordSmtpResponseForSend(ctx, {
					providerMessageId: args.providerMessageId,
					category: args.category,
					now: args.observedAt,
				}),
			};
		} catch (error) {
			// Never the recipient address or the response text: a measurement log line
			// must not become a PII sink. The category is enough to tell a systematic
			// failure apart.
			logWarn(
				`[smtpResponseCategories] failed to record ${args.category} response:`,
				error instanceof Error ? error.name : 'UnknownError'
			);
			return { result: 'no_assignment' };
		}
	},
});

// ============ AGING CRON ============

/**
 * Drop buckets past the retention horizon. Indexed, bounded and self-resuming,
 * so a backlog drains across ticks instead of blowing one transaction — the same
 * sweep shape as `cleanupExpiredOutcomes` beside it.
 */
export const cleanupExpiredSmtpResponses = internalMutation({
	args: { now: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const now = resolveNow(args.now);
		const cutoff = now - SMTP_RESPONSE_CATEGORY_RETENTION_MS;
		const expired = await ctx.db
			.query('smtpResponseCategories')
			.withIndex('by_period_start', (q) => q.lt('periodStart', cutoff))
			.take(SMTP_RESPONSE_CATEGORY_CLEANUP_BATCH_SIZE);
		await Promise.all(expired.map((row) => ctx.db.delete(row._id)));
		if (expired.length === SMTP_RESPONSE_CATEGORY_CLEANUP_BATCH_SIZE) {
			await ctx.scheduler.runAfter(
				0,
				internal.analytics.smtpResponseCategories.cleanupExpiredSmtpResponses,
				args
			);
		}
		return { deleted: expired.length };
	},
});
