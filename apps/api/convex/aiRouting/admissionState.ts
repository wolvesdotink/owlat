/**
 * What admission reads: the configured limits, the
 * complete settled totals of the current UTC day and month, and the
 * outstanding holds, all in the caller's query or mutation, so the verdict
 * and the hold that follows it are one serializable transaction.
 *
 * FAIL CLOSED (D1, #1333). The totals are verifiable only when the aggregate
 * says it is `complete` (a reconcile of the ledger's history has finished) and
 * the outstanding holds fit in one bounded read. Anything else is
 * `spend_unverifiable`, which refuses paid dispatch while a ceiling is
 * configured. With no ceiling and no shadow traffic, nothing is read and every
 * call is admitted: that is today's behaviour, and there is nothing to bound.
 */

import { resolveBudgetConfig, type SpendBudgetConfig } from '../analytics/spendBudget';
import type { QueryCtx } from '../_generated/server';
import { shadowAllowanceUsd, type ResolvedRoutingPolicy } from '@owlat/shared/aiRouting';
import { loadRoutingPolicy } from './policy';
import { spendPeriodKeys, usdToMicrousd } from '../lib/aiRouting/spendPeriods';
import {
	emptyUsage,
	evaluateAdmission,
	hasCeiling,
	type AdmissionLimits,
	type AdmissionRequestShape,
	type AdmissionVerdict,
	type PeriodUsage,
} from '../lib/aiRouting/admissionRules';

type DbCtx = { db: QueryCtx['db'] };

/**
 * The most outstanding holds one admission reads. Each in-flight paid call
 * holds one; more than this at once is not a state admission can verify in
 * one transaction, so it refuses (and the expiry sweep drains dead holds).
 */
export const MAX_OUTSTANDING_HOLDS = 500;

/** The limits in force: the env ceilings and the stored routing policy. */
export interface AdmissionContext {
	readonly config: SpendBudgetConfig;
	readonly policy: ResolvedRoutingPolicy;
	readonly limits: AdmissionLimits;
}

export async function loadAdmissionContext(ctx: DbCtx): Promise<AdmissionContext> {
	const config = resolveBudgetConfig();
	const policy = await loadRoutingPolicy(ctx);
	return {
		config,
		policy,
		limits: {
			dailyCeilingMicrousd: usdToMicrousd(config.dailyUsd),
			monthlyCeilingMicrousd: usdToMicrousd(config.monthlyUsd),
			triageAllowanceFraction: policy.triageAllowanceFraction,
			advisoryReserveFraction: config.advisoryReserveFraction,
			shadowAllowanceMicrousd: usdToMicrousd(shadowAllowanceUsd(policy, config.dailyUsd)),
		},
	};
}

export type SpendSnapshot =
	| {
			readonly isVerifiable: true;
			readonly day: PeriodUsage;
			readonly month: PeriodUsage;
			readonly heldCount: number;
	  }
	| { readonly isVerifiable: false; readonly why: 'unreconciled' | 'too_many_holds' };

/** Settled totals of one period's buckets of the current generation (older ones are stale: 0). */
async function addSettled(
	ctx: DbCtx,
	usage: PeriodUsage,
	periodKind: 'day' | 'month',
	periodKey: string,
	generation: number
): Promise<void> {
	const buckets = await ctx.db
		.query('llmSpendPeriods')
		.withIndex('by_period', (q) => q.eq('periodKind', periodKind).eq('periodKey', periodKey))
		.take(32);
	for (const bucket of buckets) {
		if (bucket.generation < generation) continue;
		usage.settled[bucket.plane][bucket.budgetClass] += bucket.settledMicrousd;
	}
}

/** The day's and month's settled totals plus every outstanding hold, or why they cannot be known. */
export async function readSpendSnapshot(ctx: DbCtx, now: number): Promise<SpendSnapshot> {
	const state = await ctx.db.query('llmSpendAggregateState').first();
	if (!state || state.status !== 'complete') return { isVerifiable: false, why: 'unreconciled' };
	const holds = await ctx.db
		.query('llmReservations')
		.withIndex('by_status_and_plane', (q) => q.eq('status', 'held'))
		.take(MAX_OUTSTANDING_HOLDS + 1);
	if (holds.length > MAX_OUTSTANDING_HOLDS) return { isVerifiable: false, why: 'too_many_holds' };

	const keys = spendPeriodKeys(now);
	const day = emptyUsage();
	const month = emptyUsage();
	await addSettled(ctx, day, 'day', keys.day, state.generation);
	await addSettled(ctx, month, 'month', keys.month, state.generation);
	// A hold is in flight now, whenever it started, so it counts in both periods.
	for (const hold of holds) {
		day.held[hold.plane][hold.budgetClass] += hold.heldMicrousd;
		month.held[hold.plane][hold.budgetClass] += hold.heldMicrousd;
	}
	return { isVerifiable: true, day, month, heldCount: holds.length };
}

/** Whether admission has anything to bound for a call of this class. */
export function needsAdmission(
	context: AdmissionContext,
	budgetClass: AdmissionRequestShape['budgetClass']
): boolean {
	return budgetClass === 'shadow' || hasCeiling(context.limits);
}

/**
 * The verdict for one call, read in the caller's transaction. Admitted
 * without a read when nothing bounds it ({@link needsAdmission}).
 */
export async function admissionVerdict(
	ctx: DbCtx,
	context: AdmissionContext,
	request: AdmissionRequestShape,
	now: number
): Promise<AdmissionVerdict> {
	if (!needsAdmission(context, request.budgetClass)) return { isAdmitted: true };
	const snapshot = await readSpendSnapshot(ctx, now);
	if (!snapshot.isVerifiable) {
		return { isAdmitted: false, reason: 'spend_unverifiable', limit: 'unverifiable' };
	}
	return evaluateAdmission(context.limits, snapshot, request);
}
