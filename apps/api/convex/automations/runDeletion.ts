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
 *   1. terminates a running run through the cancellation transition, so the
 *      cancelled counter moves exactly as `cancelAutomationRun` moves it;
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
 * cancelled here. A fresh invocation resolves the run first and stops when it
 * is gone, and cannot claim a step run that is gone. A run whose deletion
 * spans several transactions exists in between as `cancelled`; the step walker
 * does not re-check run status before executing today, so the in-flight step
 * runs are deliberately the first rows removed.
 *
 * The cancellation transition and the gauge arithmetic mirror
 * `stepExecutorQueries.ts` (`cancelAutomationRun`, `statDelta`), whose helpers
 * are private to that module; keep the two in step.
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { bumpAutomationStats } from './statShards';

/** Step runs read per query while draining one run. */
const STEP_RUN_CHUNK = 64;

type StepRunStatus = Doc<'automationStepRuns'>['status'];

/**
 * The gauge patch that releases one deleted step run from its step. Only the
 * in-flight gauges move: completed / failed / skipped are lifetime funnel
 * totals, like the run-level completed and cancelled counters, and a run that
 * really happened stays counted after its contact is gone.
 */
function inFlightGaugeRelease(
	step: Doc<'automationSteps'>,
	status: StepRunStatus
): Partial<Doc<'automationSteps'>> | null {
	switch (status) {
		case 'pending':
			return { statPending: Math.max(0, (step.statPending ?? 0) - 1) };
		case 'executing':
			return { statExecuting: Math.max(0, (step.statExecuting ?? 0) - 1) };
		default:
			return null;
	}
}

/**
 * Move a running run to `cancelled` and bump the cancelled counter, as
 * `cancelAutomationRun` does. A run that already finished is left alone, so a
 * repeated call can never count one run twice.
 */
async function terminateRun(ctx: MutationCtx, run: Doc<'automationRuns'>): Promise<void> {
	if (run.status !== 'running') return;
	await ctx.db.patch(run._id, { status: 'cancelled', completedAt: Date.now() });
	await bumpAutomationStats(ctx, run.automationId, { statsCancelled: 1 });
}

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

	await terminateRun(ctx, run);
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
			const step = await ctx.db.get(stepRun.automationStepId);
			const release = step ? inFlightGaugeRelease(step, stepRun.status) : null;
			if (step && release) await ctx.db.patch(step._id, release);
			await ctx.db.delete(stepRun._id);
			rowsTouched += 1;
		}
	}
	return { isDeleted: false, rowsTouched };
}
