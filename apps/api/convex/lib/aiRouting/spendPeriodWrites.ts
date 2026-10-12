/**
 * The live writer of the spend-period aggregate (ADR-0073, `llmSpendPeriods`).
 *
 * ONE WRITER. `analytics/llmUsage.ts` `insertLlmUsage` is the only code that
 * inserts a ledger row, and it calls {@link addLedgerRowToSpendPeriods} in the
 * same mutation, right after the insert. Settlement inserts its row through
 * `insertLlmUsage` too, so it is counted here and nowhere else. Nothing else
 * may add to a bucket: the rebuild (admission lane) recomputes buckets from
 * the ledger, it never adds live rows.
 *
 * Each row adds its micro-USD to its day bucket and its month bucket, keyed by
 * `(plane, budgetClass)`. Both buckets carry the aggregate's current
 * `generation` (from the `llmSpendAggregateState` singleton, 0 when absent). A
 * bucket from an older generation predates the current rebuild, so the writer
 * starts it again from this row instead of adding to totals the rebuild is
 * about to recount. Reading the state row is also what serializes live writers
 * behind a rebuild's start mutation (contract notes §5).
 */

import type { MutationCtx } from '../../_generated/server';
import type { LlmUsagePlane } from '../llmUsageTags';
import type { BudgetClass } from '../validators/aiRouting';
import { spendPeriodKeys } from './spendPeriods';

/** What one ledger row adds to the aggregate. */
export interface SpendPeriodContribution {
	readonly plane: LlmUsagePlane;
	readonly budgetClass: BudgetClass;
	readonly microusd: number;
	readonly isEstimated: boolean;
	/** The row's `createdAt`. */
	readonly at: number;
}

/** The aggregate's current generation; 0 before the first rebuild. */
export async function currentSpendGeneration(ctx: Pick<MutationCtx, 'db'>): Promise<number> {
	const state = await ctx.db.query('llmSpendAggregateState').first();
	return state?.generation ?? 0;
}

/** One addition to one bucket: a ledger row, or a rebuild page's sum for that bucket. */
export interface SpendBucketAddition {
	readonly periodKind: 'day' | 'month';
	readonly periodKey: string;
	readonly plane: LlmUsagePlane;
	readonly budgetClass: BudgetClass;
	readonly microusd: number;
	readonly estimatedMicrousd: number;
	readonly eventCount: number;
	/** The newest row's `createdAt` in the addition. */
	readonly at: number;
}

/**
 * Add to one bucket under `generation`. A bucket from an older generation
 * predates the current rebuild, so it starts again from this addition. Shared
 * by the live writer and the rebuild (admission lane), so both reset the same way.
 */
export async function addToSpendBucket(
	ctx: Pick<MutationCtx, 'db'>,
	generation: number,
	add: SpendBucketAddition
): Promise<void> {
	const bucket = await ctx.db
		.query('llmSpendPeriods')
		.withIndex('by_period', (q) =>
			q
				.eq('periodKind', add.periodKind)
				.eq('periodKey', add.periodKey)
				.eq('plane', add.plane)
				.eq('budgetClass', add.budgetClass)
		)
		.unique();
	if (!bucket) {
		await ctx.db.insert('llmSpendPeriods', {
			periodKind: add.periodKind,
			periodKey: add.periodKey,
			plane: add.plane,
			budgetClass: add.budgetClass,
			settledMicrousd: add.microusd,
			estimatedMicrousd: add.estimatedMicrousd,
			eventCount: add.eventCount,
			generation,
			updatedAt: add.at,
		});
		return;
	}
	const isCurrent = bucket.generation >= generation;
	await ctx.db.patch(bucket._id, {
		settledMicrousd: (isCurrent ? bucket.settledMicrousd : 0) + add.microusd,
		estimatedMicrousd: (isCurrent ? bucket.estimatedMicrousd : 0) + add.estimatedMicrousd,
		eventCount: (isCurrent ? bucket.eventCount : 0) + add.eventCount,
		generation: Math.max(bucket.generation, generation),
		updatedAt: Math.max(bucket.updatedAt, add.at),
	});
}

/**
 * Add one ledger row to its day and month buckets, in the caller's mutation.
 * `generation` is the one the caller read (and stamped on the row as
 * `spendGeneration`), so a rebuild can tell the rows it must count from the
 * rows the live writer already counted under its generation.
 */
export async function addLedgerRowToSpendPeriods(
	ctx: Pick<MutationCtx, 'db'>,
	row: SpendPeriodContribution,
	generation: number
): Promise<void> {
	const keys = spendPeriodKeys(row.at);
	const estimated = row.isEstimated ? row.microusd : 0;
	for (const [periodKind, periodKey] of [
		['day', keys.day],
		['month', keys.month],
	] as const) {
		await addToSpendBucket(ctx, generation, {
			periodKind,
			periodKey,
			plane: row.plane,
			budgetClass: row.budgetClass,
			microusd: row.microusd,
			estimatedMicrousd: estimated,
			eventCount: 1,
			at: row.at,
		});
	}
}
