/**
 * Background work defers at the spend ceiling (ADR-0073, D1): a semantic
 * file's paid steps are skipped and a later run is scheduled, a bounded
 * number of times.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { deferFileForBudget, FILE_DEFER_MS, MAX_FILE_DEFERRALS } from '../backgroundDeferral';

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
