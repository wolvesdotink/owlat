/**
 * D1 for background work (ADR-0073, Phase 1b): at the spend ceiling, or with
 * a spend state that cannot be verified, background AI work defers instead of
 * spending. A deferred semantic file keeps its extracted text now and is
 * processed again later, up to {@link MAX_FILE_DEFERRALS} times (a day), so
 * the summary and embedding arrive once the ceiling resets. Runtime-neutral.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

/** How long a deferred file waits before it is processed again. */
export const FILE_DEFER_MS = 60 * 60 * 1000;

/** How many times a file defers before it is left to the backfill paths. */
export const MAX_FILE_DEFERRALS = 24;

/** Whether background work has headroom now (nothing is held). */
export async function backgroundHasHeadroom(ctx: Pick<ActionCtx, 'runQuery'>): Promise<boolean> {
	const verdict = await ctx.runQuery(internal.aiRouting.admission.headroom, {
		plane: 'language',
		budgetClass: 'standard',
		priority: 'background',
	});
	return verdict.isAdmitted;
}

/**
 * True when the file's paid steps must defer: then a later run is scheduled
 * (while deferrals remain) and the caller skips its model and embedding calls.
 */
export async function deferFileForBudget(
	ctx: Pick<ActionCtx, 'runQuery' | 'scheduler'>,
	fileId: Id<'semanticFiles'>,
	deferrals: number | undefined
): Promise<boolean> {
	if (await backgroundHasHeadroom(ctx)) return false;
	const done = deferrals ?? 0;
	if (done < MAX_FILE_DEFERRALS) {
		await ctx.scheduler.runAfter(FILE_DEFER_MS, internal.semanticFileProcessing.processFile, {
			fileId,
			deferrals: done + 1,
		});
	}
	return true;
}
