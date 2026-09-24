/**
 * Stalled automation runs (module) — recovers a `running` run that has no
 * pending or executing step run, which nothing else would ever move again.
 *
 * The walker's own mutations never leave that state behind: every commit that
 * ends a step run enters the next one or ends the run in the same transaction
 * (`stepOrchestration.ts`). v0.5.5's walker did it in separate calls from its
 * action, so an action that died between "end this step" and "create the next
 * one" — including one cut off by the deploy of this release — left the run
 * pointing at nothing. The sweep is the safety net for those runs; it finds
 * none in steady state.
 *
 * Recovery, once a run has been quiet for {@link STALLED_RUN_GRACE_MS}:
 *   - a run with no step run at all never started: its first step is entered,
 *     exactly as `beginAutomationRun` would (or it is cancelled if the
 *     automation is no longer active). Nothing can have executed, so this can
 *     never repeat a side effect.
 *   - a run whose step runs are all terminal is CANCELLED through the run
 *     lifecycle (`cancelRun`: status, completedAt, the cancelled counter). The
 *     sweep cannot tell where it should continue: the crash may have come
 *     after the last step's side effect and before or after the index moved,
 *     and a condition step's branch is not recorded. Re-creating a step run
 *     could send the same email again under a fresh idempotency key, so the
 *     safe answer is to end the run visibly rather than guess.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { logWarn } from '../lib/runtimeLog';
import {
	cancelRun,
	enterStep,
	isTerminalStepRunStatus,
	recentStepRunsOf,
} from './stepRunTransitions';

/**
 * How long a run may sit with no active step run before the sweep acts. Well
 * above one step's action time limit and its retry backoff, so a legacy walker
 * that is merely between two of its calls is never raced.
 */
export const STALLED_RUN_GRACE_MS = 60 * 60 * 1000;

/** Running runs examined per sweep transaction. */
const SWEEP_PAGE = 100;

type Recovery = 'live' | 'started' | 'cancelled';

async function recoverIfStalled(
	ctx: MutationCtx,
	run: Doc<'automationRuns'>,
	now: number
): Promise<Recovery> {
	const recent = await recentStepRunsOf(ctx, run._id);
	if (recent.some((stepRun) => !isTerminalStepRunStatus(stepRun.status))) return 'live';

	const newest = recent[0];
	const quietSince = newest ? (newest.completedAt ?? newest._creationTime) : run.startedAt;
	if (now - quietSince < STALLED_RUN_GRACE_MS) return 'live';

	if (!newest) {
		const automation = await ctx.db.get(run.automationId);
		if (automation?.status === 'active') {
			await enterStep(ctx, run, 0);
			return 'started';
		}
	}
	await cancelRun(ctx, run._id);
	logWarn('[automations] cancelled a stalled run with no active step', {
		automationRunId: run._id,
		automationId: run.automationId,
	});
	return 'cancelled';
}

/**
 * One page of the sweep over every running run; schedules the next page until
 * the index range is exhausted. Registered in `crons.ts`.
 */
export const sweepStalledRuns = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (ctx, args): Promise<Record<Recovery, number>> => {
		const now = Date.now();
		const page = await ctx.db
			.query('automationRuns')
			.withIndex('by_status', (q) => q.eq('status', 'running'))
			.paginate({ cursor: args.cursor ?? null, numItems: SWEEP_PAGE });

		const counts: Record<Recovery, number> = { live: 0, started: 0, cancelled: 0 };
		for (const run of page.page) counts[await recoverIfStalled(ctx, run, now)]++;

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.automations.stalledRuns.sweepStalledRuns, {
				cursor: page.continueCursor,
			});
		}
		return counts;
	},
});
