/**
 * Test helpers for spend admission: reconcile the spend
 * aggregate to completion, and an action ctx whose mutations and queries run
 * against a convex-test instance, so the action-side ports reach the real
 * admission mutations.
 */

import type { TestConvex } from 'convex-test';
import { vi } from 'vitest';
import type schema from '../../schema';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';

type T = TestConvex<typeof schema>;

/** Run the rebuild to completion, page by page, without the scheduler. */
export async function reconcileSpend(t: T): Promise<void> {
	await t.mutation(internal.aiRouting.spendAggregate.ensureReconciled, {});
	for (let page = 0; page < 10_000; page++) {
		const state = await t.run((ctx) => ctx.db.query('llmSpendAggregateState').first());
		if (state?.status === 'complete') return;
		if (!state) throw new Error('no aggregate state');
		await t.mutation(internal.aiRouting.spendAggregate.rebuildPage, {
			generation: state.generation,
		});
	}
	throw new Error('the rebuild did not complete');
}

/** Settled micro-USD of the current UTC day and month, summed over every bucket of the current generation. */
export async function aggregateTotals(
	t: T,
	now = Date.now()
): Promise<{ day: number; month: number }> {
	const day = new Date(now).toISOString().slice(0, 10);
	const month = day.slice(0, 7);
	return t.run(async (ctx) => {
		const state = await ctx.db.query('llmSpendAggregateState').first();
		const generation = state?.generation ?? 0;
		const buckets = await ctx.db.query('llmSpendPeriods').collect();
		const sum = (kind: 'day' | 'month', key: string) =>
			buckets
				.filter((b) => b.periodKind === kind && b.periodKey === key && b.generation >= generation)
				.reduce((total, b) => total + b.settledMicrousd, 0);
		return { day: sum('day', day), month: sum('month', month) };
	});
}

/** An action ctx over `t`: mutations and queries run for real, the scheduler is recorded. */
export function actionCtxOver(t: T) {
	const scheduled: unknown[] = [];
	const ctx = {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a generic bridge
		runMutation: (ref: any, args: any) => t.mutation(ref, args),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a generic bridge
		runQuery: (ref: any, args: any) => t.query(ref, args),
		scheduler: {
			runAfter: vi.fn(async (_delay: number, ref: unknown, args: unknown) => {
				scheduled.push({ ref, args });
				return 'scheduled' as never;
			}),
		},
	};
	return { ctx: ctx as unknown as ActionCtx, scheduled };
}

/** One raw ledger row, as history written before the aggregate existed (no generation stamp). */
export function rawLedgerRow(costUsd: number, at: number, extra: Record<string, unknown> = {}) {
	return {
		feature: 'agent_draft',
		modelUsed: 'gpt-4o',
		promptTokens: 1000,
		completionTokens: 1000,
		totalTokens: 2000,
		costUsd,
		createdAt: at,
		...extra,
	};
}
