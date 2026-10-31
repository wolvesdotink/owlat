/**
 * The spend-period aggregate and its reconcile: complete
 * totals however many ledger rows a period holds, every row counted once
 * whether the rebuild or the live writer saw it, and admission refusing while
 * the totals are incomplete.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../_generated/api';
import { newHarness } from '../../__tests__/testModules';
import { insertLlmUsage } from '../../analytics/ledgerInsert';
import { aggregateTotals, rawLedgerRow, reconcileSpend } from './spend.testlib';

afterEach(() => {
	vi.unstubAllEnvs();
});

/** Insert `count` raw history rows of `costUsd` each, in batches. */
async function seedHistory(
	t: ReturnType<typeof newHarness>,
	count: number,
	costUsd: number,
	at: number
): Promise<void> {
	for (let start = 0; start < count; start += 2_000) {
		const size = Math.min(2_000, count - start);
		await t.run(async (ctx) => {
			for (let index = 0; index < size; index++) {
				await ctx.db.insert('llmUsageEvents', rawLedgerRow(costUsd, at));
			}
		});
	}
}

describe('the spend aggregate reconcile', () => {
	it('counts a period of more than 12,000 events exactly', async () => {
		const t = newHarness();
		await seedHistory(t, 12_500, 0.001, Date.now());

		await reconcileSpend(t);

		const totals = await aggregateTotals(t);
		// 12,500 × 1,000 micro-USD: the old 12,000-row scan would have stopped short.
		expect(totals.day).toBe(12_500_000);
		expect(totals.month).toBe(12_500_000);
		const state = await t.run((ctx) => ctx.db.query('llmSpendAggregateState').first());
		expect(state).toMatchObject({ status: 'complete', scannedCount: 12_500 });
	});

	it('counts each row once when live writes land between rebuild pages', async () => {
		const t = newHarness();
		await seedHistory(t, 4_500, 0.002, Date.now());
		await t.mutation(internal.aiRouting.spendAggregate.ensureReconciled, {});
		const state = await t.run((ctx) => ctx.db.query('llmSpendAggregateState').first());
		const generation = state!.generation;

		// A live row lands before the first page, another between pages, and one
		// after the walk passed its position: each is counted by the live writer
		// under the rebuild's generation, and the pages skip it.
		const live = async () =>
			t.run(async (ctx) => {
				await insertLlmUsage(
					ctx,
					'agent_draft',
					{ promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 },
					'gpt-4o'
				);
			});
		await live();
		await t.mutation(internal.aiRouting.spendAggregate.rebuildPage, { generation });
		await live();
		// A second chain (the stall check rescheduling a page) changes nothing.
		await t.mutation(internal.aiRouting.spendAggregate.rebuildPage, { generation });
		await reconcileSpend(t);
		await live();

		const rows = await t.run((ctx) => ctx.db.query('llmUsageEvents').collect());
		const expected = rows.reduce(
			(sum, row) => sum + (row.costMicrousd ?? Math.ceil(Math.round(row.costUsd * 1e12) / 1e6)),
			0
		);
		const totals = await aggregateTotals(t);
		expect(totals.month).toBe(expected);
		expect(totals.day).toBe(expected);
		// Live rows carry the generation they were counted under.
		expect(rows.filter((row) => row.spendGeneration === generation)).toHaveLength(3);
	});

	it('leaves rows of an earlier month out of this month', async () => {
		const t = newHarness();
		const now = Date.now();
		const lastMonth = new Date(now);
		lastMonth.setUTCDate(1);
		lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
		await t.run(async (ctx) => {
			await ctx.db.insert('llmUsageEvents', rawLedgerRow(5, lastMonth.getTime()));
			await ctx.db.insert('llmUsageEvents', rawLedgerRow(1, now));
		});
		await reconcileSpend(t);
		expect(await aggregateTotals(t, now)).toEqual({ day: 1_000_000, month: 1_000_000 });
	});

	it('restarts the buckets of an older generation on a fresh rebuild', async () => {
		const t = newHarness();
		await seedHistory(t, 10, 0.1, Date.now());
		await reconcileSpend(t);
		expect((await aggregateTotals(t)).day).toBe(1_000_000);
		// A recount of a complete aggregate (state reset to unreconciled) arrives at
		// the same totals, not double: the old generation's buckets restart.
		await t.run(async (ctx) => {
			const state = await ctx.db.query('llmSpendAggregateState').first();
			await ctx.db.patch(state!._id, { status: 'unreconciled' });
		});
		await reconcileSpend(t);
		expect((await aggregateTotals(t)).day).toBe(1_000_000);
	});

	it('refuses paid dispatch under a ceiling until the reconcile completes, then admits', async () => {
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '10');
		const t = newHarness();
		await seedHistory(t, 5, 0.1, Date.now());
		const ask = () =>
			t.query(internal.aiRouting.admission.headroom, {
				plane: 'language',
				budgetClass: 'standard',
				priority: 'pipeline',
			});
		expect(await ask()).toEqual({
			isAdmitted: false,
			reason: 'spend_unverifiable',
			limit: 'unverifiable',
		});
		await t.mutation(internal.aiRouting.spendAggregate.ensureReconciled, {});
		// Rebuilding is still incomplete.
		expect(await ask()).toMatchObject({ isAdmitted: false, reason: 'spend_unverifiable' });
		await reconcileSpend(t);
		expect(await ask()).toEqual({ isAdmitted: true });
	});

	it('resumes a rebuild whose page chain stalled', async () => {
		const t = newHarness();
		await seedHistory(t, 3, 0.1, Date.now());
		await t.mutation(internal.aiRouting.spendAggregate.ensureReconciled, {});
		await t.run(async (ctx) => {
			const state = await ctx.db.query('llmSpendAggregateState').first();
			await ctx.db.patch(state!._id, { updatedAt: Date.now() - 11 * 60 * 1000 });
		});
		await t.mutation(internal.aiRouting.spendAggregate.ensureReconciled, {});
		const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
		expect(
			scheduled.filter((job) => job.name.includes('rebuildPage')).length
		).toBeGreaterThanOrEqual(2);
		await reconcileSpend(t);
		expect((await aggregateTotals(t)).day).toBe(300_000);
	});
});
