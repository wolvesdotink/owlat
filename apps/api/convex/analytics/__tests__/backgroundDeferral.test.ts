/**
 * Background work defers at the spend ceiling: a semantic
 * file's paid steps are skipped and a later run is scheduled, a bounded
 * number of times.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import {
	BACKGROUND_DEFER_MS,
	BudgetDeferral,
	deferFileForBudget,
	deferRefusedRun,
	FILE_DEFER_MS,
	MAX_BACKGROUND_DEFERRALS,
	MAX_FILE_DEFERRALS,
} from '../backgroundDeferral';
import { AdmissionRefusedError } from '../../lib/llm/admissionPort';

const fileId = 'file-1' as Id<'semanticFiles'>;

function ctxWith(isAdmitted: boolean) {
	const runAfter = vi.fn(async () => 'job');
	const runQuery = vi.fn(async () =>
		isAdmitted ? { isAdmitted } : { isAdmitted, reason: 'daily_ceiling', limit: 'ceiling' }
	);
	return {
		ctx: { runQuery, scheduler: { runAfter } } as unknown as Pick<
			ActionCtx,
			'runQuery' | 'scheduler'
		>,
		runAfter,
		runQuery,
	};
}

describe('deferFileForBudget', () => {
	it('does not defer with headroom', async () => {
		const { ctx, runAfter, runQuery } = ctxWith(true);
		await expect(deferFileForBudget(ctx, fileId, undefined)).resolves.toBe(false);
		expect(runAfter).not.toHaveBeenCalled();
		expect(runQuery).toHaveBeenCalledWith(expect.anything(), {
			plane: 'language',
			budgetClass: 'standard',
			priority: 'background',
		});
	});

	it('defers and schedules the next run without headroom', async () => {
		const { ctx, runAfter } = ctxWith(false);
		await expect(deferFileForBudget(ctx, fileId, 2)).resolves.toBe(true);
		expect(runAfter).toHaveBeenCalledWith(FILE_DEFER_MS, expect.anything(), {
			fileId,
			deferrals: 3,
		});
	});

	it('stops rescheduling after the last deferral, still spending nothing', async () => {
		const { ctx, runAfter } = ctxWith(false);
		await expect(deferFileForBudget(ctx, fileId, MAX_FILE_DEFERRALS)).resolves.toBe(true);
		expect(runAfter).not.toHaveBeenCalled();
	});
});

describe('deferRefusedRun', () => {
	const fn = 'self' as never;

	it('schedules the same run an hour later with one more deferral, dropping the root deadline', async () => {
		const runAfter = vi.fn(async () => 'job');
		const out = await deferRefusedRun(
			{ scheduler: { runAfter } } as never,
			fn,
			{ fileId: 'f1', root: { rootRequestId: 'file:f1', deadlineAt: 1 }, deferrals: 2 },
			async () => {
				throw new AdmissionRefusedError('daily_ceiling', 'ceiling');
			}
		);
		expect(out).toBeUndefined();
		expect(runAfter).toHaveBeenCalledWith(BACKGROUND_DEFER_MS, fn, {
			fileId: 'f1',
			root: { rootRequestId: 'file:f1' },
			deferrals: 3,
		});
	});

	it('gives up after the last deferral, and leaves other errors to the run', async () => {
		const runAfter = vi.fn(async () => 'job');
		await deferRefusedRun(
			{ scheduler: { runAfter } } as never,
			fn,
			{ deferrals: MAX_BACKGROUND_DEFERRALS },
			async () => {
				throw new AdmissionRefusedError('daily_ceiling', 'ceiling');
			}
		);
		expect(runAfter).not.toHaveBeenCalled();
		await expect(
			deferRefusedRun({ scheduler: { runAfter } } as never, fn, {}, async () => {
				throw new Error('provider down');
			})
		).rejects.toThrow('provider down');
	});

	it('treats a budget refusal a fail-soft step already recorded as a refusal too', async () => {
		const runAfter = vi.fn(async () => 'job');
		await deferRefusedRun({ scheduler: { runAfter } } as never, fn, {}, async () => {
			throw new BudgetDeferral();
		});
		expect(runAfter).toHaveBeenCalledTimes(1);
	});
});
