/**
 * Reconciling the spend-period aggregate with the ledger.
 *
 * `llmSpendPeriods` is derived only from `llmUsageEvents`: the ledger insert
 * adds every new row to its buckets (`analytics/ledgerInsert.ts`), and this
 * module recounts history, which the live writer never saw (rows written
 * before the aggregate existed). Until a recount has finished, admission reads
 * the totals as unverifiable and refuses paid dispatch under a ceiling.
 *
 * THE PROTOCOL. {@link ensureReconciled} starts a rebuild when the aggregate
 * is not reconciled: one mutation bumps `generation` and records the cutoff.
 * Every ledger insert reads the same state row, so inserts serialize around
 * that mutation, and each row is stamped with the generation it was counted
 * under (`spendGeneration`). Each {@link rebuildPage} walks the ledger from
 * the start of the cutoff's UTC month and counts exactly the rows whose stamp
 * is older than the rebuild's generation (absent counts as older); rows the
 * live writer already counted under this generation are skipped. So a row is
 * counted once, by one of the two, whichever order the mutations ran in.
 * Buckets from an older generation are restarted by the first addition of
 * the new one (`addToSpendBucket`), and readers treat them as zero.
 *
 * SCOPE. Admission reads the current day and month, so a rebuild recounts
 * from the start of the current month; later periods are complete because
 * every insert after the start is live. Older buckets are left as they were.
 *
 * The cursor lives on the state row and each page reads it from there, so two
 * chains (a page rescheduled by the stall check while the first still runs)
 * serialize on the state row and never count a row twice.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { utcMonthStart } from '../lib/clock';
import {
	ledgerRowBudgetClass,
	ledgerRowMicrousd,
	spendPeriodKeys,
} from '../lib/aiRouting/spendPeriods';
import { addToSpendBucket, type SpendBucketAddition } from '../lib/aiRouting/spendPeriodWrites';

/** Ledger rows per rebuild page (well inside a mutation's read limits). */
export const REBUILD_PAGE_SIZE = 2_000;

/** A rebuild whose state has not moved for this long has lost its page chain. */
export const REBUILD_STALL_MS = 10 * 60 * 1000;

async function startRebuild(ctx: MutationCtx, now: number): Promise<void> {
	const state = await ctx.db.query('llmSpendAggregateState').first();
	const generation = (state?.generation ?? 0) + 1;
	const fields = {
		status: 'rebuilding' as const,
		generation,
		rebuildCutoff: now,
		cursor: undefined,
		scannedCount: 0,
		startedAt: now,
		completedAt: undefined,
		lastError: undefined,
		updatedAt: now,
	};
	if (state) await ctx.db.patch(state._id, fields);
	else await ctx.db.insert('llmSpendAggregateState', fields);
	await ctx.scheduler.runAfter(0, internal.aiRouting.spendAggregate.rebuildPage, { generation });
}

/**
 * Start a rebuild when the aggregate is unreconciled, and resume one whose
 * page chain stalled. Idempotent; the expiry sweep and a refused admission
 * both call it.
 */
export const ensureReconciled = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const state = await ctx.db.query('llmSpendAggregateState').first();
		if (!state || state.status === 'unreconciled') {
			await startRebuild(ctx, now);
			return;
		}
		if (state.status === 'rebuilding' && now - state.updatedAt > REBUILD_STALL_MS) {
			await ctx.db.patch(state._id, { updatedAt: now });
			await ctx.scheduler.runAfter(0, internal.aiRouting.spendAggregate.rebuildPage, {
				generation: state.generation,
			});
		}
	},
});

/** Count one page of the ledger into the buckets of `generation`. */
export const rebuildPage = internalMutation({
	args: { generation: v.number() },
	handler: async (ctx, args) => {
		const state = await ctx.db.query('llmSpendAggregateState').first();
		if (!state || state.status !== 'rebuilding' || state.generation !== args.generation) return;
		const from = utcMonthStart(state.rebuildCutoff ?? state.startedAt ?? state.updatedAt);
		const page = await ctx.db
			.query('llmUsageEvents')
			.withIndex('by_creation_time', (q) => q.gte('_creationTime', from))
			.paginate({ cursor: state.cursor ?? null, numItems: REBUILD_PAGE_SIZE });

		const additions = new Map<string, SpendBucketAddition>();
		for (const row of page.page) {
			// Counted live under this generation (or a later one): not ours.
			if ((row.spendGeneration ?? -1) >= args.generation) continue;
			if (row.createdAt < from) continue;
			const microusd = ledgerRowMicrousd(row);
			const estimated = row.isEstimated === true ? microusd : 0;
			const plane = row.plane ?? 'language';
			const budgetClass = ledgerRowBudgetClass(row);
			const keys = spendPeriodKeys(row.createdAt);
			for (const [periodKind, periodKey] of [
				['day', keys.day],
				['month', keys.month],
			] as const) {
				const key = `${periodKind}|${periodKey}|${plane}|${budgetClass}`;
				const prior = additions.get(key);
				additions.set(key, {
					periodKind,
					periodKey,
					plane,
					budgetClass,
					microusd: (prior?.microusd ?? 0) + microusd,
					estimatedMicrousd: (prior?.estimatedMicrousd ?? 0) + estimated,
					eventCount: (prior?.eventCount ?? 0) + 1,
					at: Math.max(prior?.at ?? 0, row.createdAt),
				});
			}
		}
		for (const addition of additions.values()) {
			await addToSpendBucket(ctx, args.generation, addition);
		}

		const now = Date.now();
		const scannedCount = state.scannedCount + page.page.length;
		if (page.isDone) {
			await ctx.db.patch(state._id, {
				status: 'complete',
				cursor: undefined,
				scannedCount,
				completedAt: now,
				updatedAt: now,
			});
			return;
		}
		await ctx.db.patch(state._id, { cursor: page.continueCursor, scannedCount, updatedAt: now });
		await ctx.scheduler.runAfter(0, internal.aiRouting.spendAggregate.rebuildPage, {
			generation: args.generation,
		});
	},
});
