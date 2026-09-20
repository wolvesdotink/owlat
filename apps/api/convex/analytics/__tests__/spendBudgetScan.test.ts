/**
 * The spend budget's LEDGER SCAN, as opposed to the pure evaluation core in
 * `spendBudget.test.ts`.
 *
 * Two properties, and they pull in opposite directions, which is why they are
 * tested together.
 *
 * The scan is bounded, and the ceiling it feeds exists because an org — or a
 * prompt-injected auto-reply loop — can run up unbounded spend. A cap that
 * silently truncates therefore says the least on exactly the runaway day the
 * ceiling was written for. Adding one decision row per inbound message pushes a
 * busy deployment over the old 10,000-row cap, so the under-report stops being
 * theoretical: the cap is raised and a truncated scan now says what the rate it
 * saw would extrapolate to.
 *
 * But the extrapolation NEVER GATES MAIL. Rows do not arrive evenly, and a rate
 * read off a burst window would withhold auto-send over money nobody spent —
 * on an install that has nothing to do with any of this. So `state`,
 * `autonomousAutoSendAllowed` and `advisoryAllowed` bind on the COUNTED figure,
 * and the projection drives `warn` and the surfaces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryCtx } from '../../_generated/server';
import { computeBudgetStatus, projectScannedSpend } from '../spendBudget';

const BUDGET_ENV = [
	'AI_SPEND_DAILY_BUDGET_USD',
	'AI_SPEND_MONTHLY_BUDGET_USD',
	'AI_SPEND_WARN_FRACTION',
	'AI_SPEND_ADVISORY_RESERVE_FRACTION',
] as const;

/** Mid-month, mid-day, so both period windows are wide and deterministic. */
const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);
const DAY_START = Date.UTC(2026, 8, 17);
const MONTH_START = Date.UTC(2026, 8, 1);
const HOUR = 60 * 60 * 1000;

interface LedgerRow {
	_creationTime: number;
	createdAt: number;
	costUsd: number;
}

/**
 * The narrow slice of `ctx.db` the scan uses:
 * `query(table).withIndex('by_creation_time', q => q.gte(...)).order('desc').take(n)`.
 * Hand-rolled rather than `convexTest` so twenty thousand rows cost nothing and
 * the cap itself — not a mock of it — is what the assertions exercise.
 */
function ledgerCtx(rows: readonly LedgerRow[]): QueryCtx {
	const db = {
		query(table: string) {
			expect(table).toBe('llmUsageEvents');
			let lowerBound = Number.NEGATIVE_INFINITY;
			const range = {
				gte(field: string, value: number) {
					expect(field).toBe('_creationTime');
					lowerBound = value;
					return range;
				},
			};
			const cursor = {
				withIndex(index: string, build: (q: typeof range) => typeof range) {
					expect(index).toBe('by_creation_time');
					build(range);
					return cursor;
				},
				order(direction: 'asc' | 'desc') {
					expect(direction).toBe('desc');
					return cursor;
				},
				take(count: number) {
					return rows
						.filter((row) => row._creationTime >= lowerBound)
						.sort((left, right) => right._creationTime - left._creationTime)
						.slice(0, count);
				},
			};
			return cursor;
		},
	};
	return { db } as unknown as QueryCtx;
}

/** `count` rows of equal cost, spread evenly across `[now - spanMs, now]`. */
function spreadRows(count: number, costUsd: number, spanMs: number): LedgerRow[] {
	return Array.from({ length: count }, (_, index) => {
		const at = NOW - Math.round((spanMs * index) / count);
		return { _creationTime: at, createdAt: at, costUsd };
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
	for (const key of BUDGET_ENV) delete process.env[key];
});

describe('computeBudgetStatus over a truncated ledger', () => {
	it('warns on the MONTHLY projection a capped scan used to hide', async () => {
		process.env['AI_SPEND_MONTHLY_BUDGET_USD'] = '100';
		// 20,000 rows × $0.006 = $120 spent against a $100 ceiling, spread evenly
		// over the month. The old scan reached 10,000 of them ($60) and reported
		// `ok` with nothing else to say; the raised cap reaches 12,000 ($72) and
		// the projection names the $120 the rate implies.
		const ctx = ledgerCtx(spreadRows(20_000, 0.006, NOW - MONTH_START));

		const status = await computeBudgetStatus(ctx);

		expect(status.monthly.spentUsd).toBeCloseTo(72, 0);
		expect(status.monthly.projectedUsd).toBeCloseTo(120, 0);
		expect(status.monthly.projected).toBe(true);
		expect(status.projected).toBe(true);
		expect(status.warn).toBe(true);
	});

	it('does NOT withhold auto-send on a projection, however alarming', async () => {
		process.env['AI_SPEND_DAILY_BUDGET_USD'] = '100';
		// The keyless install this rule protects: a bulk re-index emits the whole
		// scan's worth of rows in the last half hour of a twelve-hour day. $20 was
		// spent; the rate over that half hour extrapolates to $480.
		const ctx = ledgerCtx(spreadRows(20_000, 0.001, HOUR / 2));

		const status = await computeBudgetStatus(ctx);

		expect(status.daily.spentUsd).toBeCloseTo(12, 0);
		expect(status.daily.projectedUsd).toBeGreaterThan(100);
		expect(status.daily.state).not.toBe('exceeded');
		// The gate stays exactly where it was: nothing is withheld over a rate.
		expect(status.autonomousAutoSendAllowed).toBe(true);
		expect(status.advisoryAllowed).toBe(true);
		// The deployment is still told.
		expect(status.warn).toBe(true);
		expect(status.daily.projected).toBe(true);
	});

	it('still binds the ceiling on what the scan actually counted', async () => {
		process.env['AI_SPEND_DAILY_BUDGET_USD'] = '100';
		// Counted, not projected: the scan reaches 12,000 rows × $0.02 = $240.
		const ctx = ledgerCtx(spreadRows(20_000, 0.02, 12 * HOUR));

		const status = await computeBudgetStatus(ctx);

		expect(status.daily.spentUsd).toBeGreaterThan(100);
		expect(status.daily.state).toBe('exceeded');
		expect(status.autonomousAutoSendAllowed).toBe(false);
		expect(status.reason).toMatch(/AI spend budget exhausted/i);
	});

	it('reports a scan that fits as counted fact, not as a projection', async () => {
		process.env['AI_SPEND_MONTHLY_BUDGET_USD'] = '100';
		const ctx = ledgerCtx(spreadRows(11_999, 0.001, NOW - MONTH_START));

		const status = await computeBudgetStatus(ctx);

		expect(status.monthly.spentUsd).toBeCloseTo(11.999, 6);
		expect(status.monthly.projectedUsd).toBeCloseTo(11.999, 6);
		expect(status.monthly.projected).toBe(false);
		expect(status.monthly.state).toBe('ok');
		expect(status.projected).toBe(false);
		expect(status.warn).toBe(false);
	});

	it('skips the ledger entirely when no ceiling is configured', async () => {
		const ctx = ledgerCtx(spreadRows(20_000, 0.006, NOW - MONTH_START));
		const query = vi.spyOn(ctx.db, 'query');

		const status = await computeBudgetStatus(ctx);

		expect(query).not.toHaveBeenCalled();
		expect(status.configured).toBe(false);
		expect(status.autonomousAutoSendAllowed).toBe(true);
	});
});

describe('projectScannedSpend', () => {
	const bounds = { now: NOW, dayStart: DAY_START, monthStart: MONTH_START };

	it('sums an untruncated slice exactly and claims nothing', () => {
		const rows = [
			{ at: NOW - HOUR, costUsd: 1 },
			{ at: DAY_START - HOUR, costUsd: 2 },
			{ at: MONTH_START - HOUR, costUsd: 99 },
		];

		expect(projectScannedSpend(rows, bounds, false)).toEqual({
			dailyUsd: 1,
			monthlyUsd: 3,
			dailyProjectedUsd: 1,
			monthlyProjectedUsd: 3,
		});
	});

	it('leaves a period alone when the truncated scan still covered all of it', () => {
		// Truncation that stopped before the month began only means the scan ran out
		// on rows we were never going to count.
		const rows = [
			{ at: NOW - HOUR, costUsd: 1 },
			{ at: MONTH_START - HOUR, costUsd: 50 },
		];

		expect(projectScannedSpend(rows, bounds, true)).toEqual({
			dailyUsd: 1,
			monthlyUsd: 1,
			dailyProjectedUsd: 1,
			monthlyProjectedUsd: 1,
		});
	});

	it('projects each period at the rate observed over the part it reached', () => {
		// Scan covers the last 6 hours of a 12-hour day and a 16½-day month.
		const rows = [
			{ at: NOW - HOUR, costUsd: 3 },
			{ at: NOW - 6 * HOUR, costUsd: 3 },
		];

		const spend = projectScannedSpend(rows, bounds, true);

		// Counted stays counted; the extrapolation is a second number beside it.
		expect(spend.dailyUsd).toBe(6);
		expect(spend.monthlyUsd).toBe(6);
		expect(spend.dailyProjectedUsd).toBeCloseTo(6 * (12 / 6), 6);
		expect(spend.monthlyProjectedUsd).toBeCloseTo(6 * ((NOW - MONTH_START) / (6 * HOUR)), 6);
	});

	it('stays finite when every scanned row landed in the same millisecond', () => {
		// 12,000 priced calls in one instant is a runaway, and reads as one.
		const rows = [
			{ at: NOW, costUsd: 5 },
			{ at: NOW, costUsd: 5 },
		];

		const spend = projectScannedSpend(rows, bounds, true);

		expect(Number.isFinite(spend.monthlyProjectedUsd)).toBe(true);
		expect(spend.monthlyProjectedUsd).toBeGreaterThan(10);
		expect(spend.monthlyUsd).toBe(10);
	});
});
