/**
 * The spend-period aggregate's keys and money unit (ADR-0073), shared by every
 * writer and reader of `llmSpendPeriods` so they cannot disagree about which
 * bucket a ledger row lands in or how much it counts for.
 *
 * The aggregate is derived only from `llmUsageEvents`: each ledger insert (and
 * each settlement that inserts) adds the row's micro-USD to the day and month
 * bucket of its plane and budget class, in the same mutation, and a rebuild can
 * recompute every bucket from the ledger alone. Pure.
 */

import { utcDayKey, utcMonthKey } from '../clock';
import type { BudgetClass } from '../validators/aiRouting';

/** The two bucket keys a ledger row written at `at` counts towards. */
export interface SpendPeriodKeys {
	/** `YYYY-MM-DD` (UTC). */
	readonly day: string;
	/** `YYYY-MM` (UTC). */
	readonly month: string;
}

export function spendPeriodKeys(at: number): SpendPeriodKeys {
	return { day: utcDayKey(at), month: utcMonthKey(at) };
}

/**
 * USD → integer micro-USD, rounded UP so the aggregate never under-counts. The
 * float is first rounded to pico-USD so `0.1` (stored as 0.1000…01) counts as
 * 100,000 rather than 100,001.
 */
export function usdToMicrousd(usd: number): number {
	if (!Number.isFinite(usd) || usd <= 0) return 0;
	return Math.ceil(Math.round(usd * 1e12) / 1e6);
}

/** The fields of a ledger row the aggregate reads. Structural, so it tests with plain rows. */
export interface AggregatedLedgerRow {
	readonly costUsd: number;
	readonly costMicrousd?: number;
	readonly budgetClass?: BudgetClass;
}

/** What one ledger row adds to its buckets: its integer cost, exact when the writer stored it. */
export function ledgerRowMicrousd(row: AggregatedLedgerRow): number {
	const exact = row.costMicrousd;
	if (exact !== undefined && Number.isSafeInteger(exact) && exact >= 0) return exact;
	return usdToMicrousd(row.costUsd);
}

/** The budget class a ledger row counts under. Rows from before the field read as `standard`. */
export function ledgerRowBudgetClass(row: AggregatedLedgerRow): BudgetClass {
	return row.budgetClass ?? 'standard';
}
