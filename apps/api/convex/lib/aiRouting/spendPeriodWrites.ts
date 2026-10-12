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
async function currentGeneration(ctx: MutationCtx): Promise<number> {
	const state = await ctx.db.query('llmSpendAggregateState').first();
	return state?.generation ?? 0;
}

/** Add one ledger row to its day and month buckets, in the caller's mutation. */
export async function addLedgerRowToSpendPeriods(
	ctx: MutationCtx,
	row: SpendPeriodContribution
): Promise<void> {
	const generation = await currentGeneration(ctx);
	const keys = spendPeriodKeys(row.at);
	const estimated = row.isEstimated ? row.microusd : 0;
	for (const [periodKind, periodKey] of [
		['day', keys.day],
		['month', keys.month],
	] as const) {
		const bucket = await ctx.db
			.query('llmSpendPeriods')
			.withIndex('by_period', (q) =>
				q
					.eq('periodKind', periodKind)
					.eq('periodKey', periodKey)
					.eq('plane', row.plane)
					.eq('budgetClass', row.budgetClass)
			)
			.unique();
		if (!bucket) {
			await ctx.db.insert('llmSpendPeriods', {
				periodKind,
				periodKey,
				plane: row.plane,
				budgetClass: row.budgetClass,
				settledMicrousd: row.microusd,
				estimatedMicrousd: estimated,
				eventCount: 1,
				generation,
				updatedAt: row.at,
			});
			continue;
		}
		const isCurrent = bucket.generation >= generation;
		await ctx.db.patch(bucket._id, {
			settledMicrousd: (isCurrent ? bucket.settledMicrousd : 0) + row.microusd,
			estimatedMicrousd: (isCurrent ? bucket.estimatedMicrousd : 0) + estimated,
			eventCount: (isCurrent ? bucket.eventCount : 0) + 1,
			generation: Math.max(bucket.generation, generation),
			updatedAt: Math.max(bucket.updatedAt, row.at),
		});
	}
}
