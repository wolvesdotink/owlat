/**
 * Automation run deletion lifecycle — the one way to remove an `automationRuns`
 * row together with everything that hangs off it.
 *
 * Deleting a run row directly (what contact erasure used to do) broke two
 * things. The run's `automationStepRuns` were left behind pointing at nothing,
 * and a still-running run never reached a terminal state, so the automation's
 * derived active total (entered − completed − cancelled, see statShards.ts)
 * counted it as active forever. This module:
 *
 *   1. terminates a running run through the walker's own cancellation
 *      (`stepRunTransitions.cancelRun`), so the cancelled counter moves exactly once;
 *   2. deletes the step runs newest first — the in-flight ones (the only
 *      pending/executing rows a run has are its latest) go in the first batch
 *      — releasing each in-flight row from its step's pending/executing gauge;
 *   3. deletes the run once no step run is left.
 *
 * Every call does at most `maxRows` step-run deletions, so a caller walking a
 * large history can spread the work over several transactions and call again;
 * the run row is deleted last, which is what makes a partial pass resumable.
 *
 * Scheduled `executeStep` invocations are not tracked by id and cannot be
 * cancelled here; the orchestration mutations make them harmless instead
 * (stepOrchestration.ts). A claim of a step run that is gone is dropped, and a
 * claim while the run is already `cancelled` (a deletion spanning several
 * transactions) skips the step run without running its side effect. An
 * attempt that claimed before the deletion and is still inside its side
 * effect finds its step run gone at finalize/retry and is a stale no-op, so
 * it can neither advance nor resurrect the run. The recovery sweep only reads
 * step runs that still exist, so a deleted row is never re-dispatched.
 */

import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import {
	applyStepStatusTransition,
	cancelRun,
	isTerminalStepRunStatus,
} from './stepRunTransitions';

/** Step runs read per query while draining one run. */
const STEP_RUN_CHUNK = 64;

interface RunDeletionProgress {
	/** True once the run row itself is gone (or was already gone). */
	isDeleted: boolean;
	/** Rows deleted or patched by this call, for the caller's budget. */
	rowsTouched: number;
}

/**
 * Terminate `runId`, delete up to `maxRows` of its step runs, and delete the
 * run when none remain. Call again until `isDeleted` to finish a large run.
 */
export async function deleteAutomationRun(
	ctx: MutationCtx,
	runId: Id<'automationRuns'>,
	maxRows: number
): Promise<RunDeletionProgress> {
	const run = await ctx.db.get(runId);
	if (!run) return { isDeleted: true, rowsTouched: 0 };

	await cancelRun(ctx, run._id);
	let rowsTouched = 1;

	while (rowsTouched < maxRows) {
		const stepRuns = await ctx.db
			.query('automationStepRuns')
			.withIndex('by_automation_run', (q) => q.eq('automationRunId', runId))
			.order('desc')
			.take(Math.min(STEP_RUN_CHUNK, maxRows - rowsTouched));
		if (stepRuns.length === 0) {
			await ctx.db.delete(runId);
			return { isDeleted: true, rowsTouched: rowsTouched + 1 };
		}
		for (const stepRun of stepRuns) {
			// Only the in-flight gauges are released: completed / failed / skipped
			// are lifetime funnel totals, like the run-level completed and
			// cancelled counters, and work that really happened stays counted
			// after its contact is gone.
			if (!isTerminalStepRunStatus(stepRun.status)) {
				await applyStepStatusTransition(ctx, stepRun.automationStepId, stepRun.status, null);
			}
			await ctx.db.delete(stepRun._id);
			rowsTouched += 1;
		}
	}
	return { isDeleted: false, rowsTouched };
}
