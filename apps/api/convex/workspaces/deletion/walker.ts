/**
 * Organization deletion walker — the functions that drive a workspace deletion
 * job (`job.ts`) through the scheduler quiesce and the ordered cascade in
 * `steps/registry.ts`.
 *
 *   tick           one transaction of the job: a scheduler page, a sweep batch
 *                  or a verification pass, then the checkpoint on the job's
 *                  progress row.
 *   drive          the action that chains ticks and reschedules itself. It
 *                  exists so a failing tick can be RECORDED: a mutation that
 *                  throws rolls back everything it wrote, including any note
 *                  about the error.
 *   recordFailure  counts the attempt, keeps the error on the progress row, and
 *                  retries with backoff, or marks the job `failed` once retries
 *                  run out.
 *   recover        the recovery driver (a cron): restarts a job whose chain went
 *                  quiet and re-arms a failed one, from the saved checkpoint.
 *   abort          the operator's exit: ends the job without completing it and
 *                  lifts the fence, with an audit row.
 *   status         the operator's view of the job.
 *
 * Two chains on one job are harmless: every tick is a serializable transaction
 * and every step is idempotent, so restarting a job whose chain might still be
 * alive is always safe.
 *
 * THE FENCE EXEMPTION. Every other mutation in the backend is built with the
 * fenced builders (lib/writeFence.ts), which refuse writes to the swept tables
 * while a job is active. The mutations here are the deletion worker itself, so
 * they are built on the raw `_generated/server` builder, and this module is the
 * only one `scripts/check-write-fence.ts` allows to do that. Keep it that way:
 * anything a step needs must run inline on the worker's context, never through
 * `ctx.runMutation`, whose callee would be fenced.
 *
 * See docs/adr/0025-organization-deletion-module-family.md, including its
 * "Amendment: durable lifecycle and write fence" (#898).
 */

import { v } from 'convex/values';
// The RAW `internalMutation`, not lib/writeFence's: the deletion worker is the
// one writer the fence exempts (see above).
import { internalAction, internalMutation, internalQuery } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { logError } from '../../lib/runtimeLog';
import { readActiveWorkspaceDeletion } from '../../lib/writeFence';
import {
	abortWorkspaceDeletion,
	beginWorkspaceDeletion,
	nextTable,
	readDeletionProgress,
	readLatestDeletionJob,
	rearmWorkspaceDeletion,
	runWorkspaceDeletionTransaction,
	scheduleDeletionDrive,
	type DeletionJobSummary,
	type DeletionTickOutcome,
} from './job';
import { isTransactionLimitError } from '../../lib/convexLimitErrors';
import { shrunkPageRows } from './quiesce';
import { organizationDeletionTableValidator } from './steps/_common';
import { ORGANIZATION_DELETION_STEPS, STEPS } from './steps/registry';

export { nextTable };

/** Ticks one `drive` invocation chains before it reschedules itself. */
const TICKS_PER_DRIVE = 20;
/** Backoff before retry N (1-based) of a failed transaction. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const MAX_ERROR_CHARS = 500;
/**
 * A `running` or `retrying` job untouched this long has lost its chain. Longer
 * than the longest retry backoff, so a job waiting out a scheduled retry is
 * never mistaken for a stalled one and given a second chain.
 */
export const DELETION_STALLED_AFTER_MS = Math.max(...RETRY_DELAYS_MS) + 15 * 60 * 1000;
/** How long a `failed` job waits before the recovery driver re-arms it. */
export const FAILED_DELETION_RETRY_AFTER_MS = 60 * 60 * 1000;

export const tick = internalMutation({
	args: { jobId: v.id('workspaceDeletionJobs') },
	handler: async (ctx, { jobId }): Promise<DeletionTickOutcome> =>
		runWorkspaceDeletionTransaction(ctx, jobId),
});

export const drive = internalAction({
	args: { jobId: v.id('workspaceDeletionJobs') },
	handler: async (ctx, { jobId }): Promise<void> => {
		// A chain whose job finished, or failed and waits for recovery, stops
		// here without a write transaction.
		const job: DeletionJobSummary | null = await ctx.runQuery(
			internal.workspaces.deletion.walker.status,
			{}
		);
		if (job === null || job.jobId !== jobId || !job.isActive || job.status === 'failed') return;
		for (let i = 0; i < TICKS_PER_DRIVE; i++) {
			let outcome: DeletionTickOutcome;
			try {
				outcome = await ctx.runMutation(internal.workspaces.deletion.walker.tick, { jobId });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await ctx.runMutation(internal.workspaces.deletion.walker.recordFailure, {
					jobId,
					error: message.slice(0, MAX_ERROR_CHARS),
				});
				return;
			}
			if (outcome !== 'more') return;
		}
		await ctx.scheduler.runAfter(0, internal.workspaces.deletion.walker.drive, { jobId });
	},
});

export const recordFailure = internalMutation({
	args: { jobId: v.id('workspaceDeletionJobs'), error: v.string() },
	handler: async (ctx, { jobId, error }): Promise<void> => {
		const job = await ctx.db.get(jobId);
		const progress = await readDeletionProgress(ctx.db, jobId);
		if (!job || !job.isActive || !progress) return;
		const attempts = progress.attempts + 1;
		const isExhausted = attempts >= MAX_ATTEMPTS;
		const now = Date.now();
		// A scheduler page that failed is retried smaller, never as the same read
		// again: straight to one row after a limit error, which then fits, so its
		// retry does not wait out the longer backoff with the fence up.
		const isScanning = progress.phase === 'quiesce' || progress.phase === 'verify';
		const isScanLimit = isScanning && isTransactionLimitError(error);
		await ctx.db.patch(progress._id, {
			...(isScanning ? { scheduledPageRows: shrunkPageRows(progress, error) } : {}),
			attempts,
			lastError: error.slice(0, MAX_ERROR_CHARS),
			lastErrorAt: now,
			lastErrorStep: progress.step,
			status: isExhausted ? 'failed' : 'retrying',
			updatedAt: now,
		});
		// The step only: the error text stays on the progress row.
		logError('[workspace deletion] transaction failed', {
			generation: job.generation,
			phase: progress.phase,
			step: progress.step,
			attempts,
			isExhausted,
		});
		if (!isExhausted) {
			const delayMs = isScanLimit
				? RETRY_DELAYS_MS[0]
				: (RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[0]);
			await scheduleDeletionDrive(ctx, jobId, delayMs);
		}
	},
});

/**
 * The recovery driver, run by a cron. Restarts the active job from its saved
 * step when its chain went quiet (a lost schedule, a crashed action, a
 * redeploy), and re-arms a `failed` one once it has waited, so a deletion never
 * stays half done with the fence up just because one attempt ran out of luck.
 */
export const recover = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ isRestarted: boolean }> => {
		const job = await readActiveWorkspaceDeletion(ctx.db);
		const progress = job ? await readDeletionProgress(ctx.db, job._id) : null;
		if (!progress) return { isRestarted: false };
		const now = Date.now();
		const idleMs = now - progress.updatedAt;
		if (progress.status === 'failed') {
			if (idleMs < FAILED_DELETION_RETRY_AFTER_MS) return { isRestarted: false };
			await rearmWorkspaceDeletion(ctx, progress, now);
			return { isRestarted: true };
		}
		if (idleMs < DELETION_STALLED_AFTER_MS) return { isRestarted: false };
		await ctx.db.patch(progress._id, { status: 'running', updatedAt: now });
		await scheduleDeletionDrive(ctx, progress.jobId);
		return { isRestarted: true };
	},
});

/**
 * End the active deletion WITHOUT completing it, lifting the write fence. The
 * way out for a job that cannot finish; run it by hand
 * (`npx convex run workspaces/deletion/walker:abort '{"operator":…,"reason":…}'`).
 * Whatever the sweep had not reached stays in place, and the workspace takes
 * writes again. Returns the aborted generation, or `null` when none was active.
 */
export const abort = internalMutation({
	args: { operator: v.string(), reason: v.string() },
	handler: async (ctx, args): Promise<{ generation: number } | null> =>
		abortWorkspaceDeletion(ctx, {
			operator: args.operator.slice(0, 200),
			reason: args.reason.slice(0, MAX_ERROR_CHARS),
		}),
});

/** The active deletion job, else the most recent one, else `null`. */
export const status = internalQuery({
	args: {},
	handler: async (ctx): Promise<DeletionJobSummary | null> => readLatestDeletionJob(ctx.db),
});

// ============== previous-release entry points — remove after the next release ==============
//
// The previous release scheduled `start` from `settings.remove` and the account
// deletion cron, and chained `runStep` hops through the tables with no job row.
// Jobs it queued before the deploy still arrive here by path.

/** The previous release's entry point: now opens (or joins) the job. */
export const start = internalMutation({
	args: {},
	handler: async (ctx): Promise<void> => {
		await beginWorkspaceDeletion(ctx, { source: 'previous_release' });
	},
});

/**
 * The previous release's self-scheduled hop. Runs its batch, then adopts the
 * walk into a job that resumes at the table the hop would have continued with
 * (after quiescing the scheduler), so the rest of it is fenced, checkpointed
 * and verified. When a job already exists its chain owns progress and the hop
 * stops after its batch.
 */
export const runStep = internalMutation({
	args: { table: organizationDeletionTableValidator },
	handler: async (ctx, { table }): Promise<void> => {
		const { hasMore } = await ORGANIZATION_DELETION_STEPS[table].deleteBatch(ctx);
		if (await readActiveWorkspaceDeletion(ctx.db)) return;
		// Past the last table there is nothing left to sweep: re-sweeping the
		// (empty) last one costs one transaction and leads straight to verify.
		const resumeAt = (hasMore ? table : nextTable(table)) ?? STEPS[STEPS.length - 1] ?? STEPS[0];
		await beginWorkspaceDeletion(ctx, { source: 'previous_release' }, resumeAt);
	},
});
