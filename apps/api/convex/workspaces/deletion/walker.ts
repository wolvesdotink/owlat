/**
 * Organization deletion walker — the functions that drive a workspace deletion
 * job (`job.ts`) through the ordered cascade in `steps/registry.ts`.
 *
 *   tick           one transaction of the job: a sweep batch or a verification
 *                  pass, then the checkpoint on the job row.
 *   drive          the action that chains ticks and reschedules itself. It
 *                  exists so a failing tick can be RECORDED: a mutation that
 *                  throws rolls back everything it wrote, including any note
 *                  about the error.
 *   recordFailure  counts the attempt, keeps the error on the job, and retries
 *                  with backoff, or marks the job `failed` once retries run out.
 *   recover        the recovery driver (a cron): restarts a job whose chain went
 *                  quiet and re-arms a failed one, from the saved checkpoint.
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
 * only one `scripts/check-write-fence.sh` allows to do that. Keep it that way:
 * anything a step needs must run inline on the worker's context, never through
 * `ctx.runMutation`, whose callee would be fenced.
 *
 * See docs/adr/0025-organization-deletion-module-family.md and
 * docs/adr/0062-workspace-deletion-lifecycle.md.
 */

import { v } from 'convex/values';
// The RAW `internalMutation`, not lib/writeFence's: the deletion worker is the
// one writer the fence exempts (see above).
import { internalAction, internalMutation, internalQuery } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { logError } from '../../lib/runtimeLog';
import { readActiveWorkspaceDeletion } from '../../lib/writeFence';
import {
	beginWorkspaceDeletion,
	nextTable,
	readLatestDeletionJob,
	runWorkspaceDeletionTransaction,
	scheduleDeletionDrive,
	summarizeDeletionJob,
	type DeletionJobSummary,
	type DeletionTickOutcome,
} from './job';
import { organizationDeletionTableValidator } from './steps/_common';
import { ORGANIZATION_DELETION_STEPS, STEPS } from './steps/registry';

export { nextTable };

/** Ticks one `drive` invocation chains before it reschedules itself. */
const TICKS_PER_DRIVE = 20;
/** Backoff before retry N (1-based) of a failed transaction. */
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const MAX_ERROR_CHARS = 500;
/** A `running` or `retrying` job untouched this long has lost its chain. */
export const DELETION_STALLED_AFTER_MS = 15 * 60 * 1000;
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
		if (!job || !job.isActive) return;
		const attempts = job.attempts + 1;
		const isExhausted = attempts >= MAX_ATTEMPTS;
		const now = Date.now();
		await ctx.db.patch(jobId, {
			attempts,
			lastError: error.slice(0, MAX_ERROR_CHARS),
			lastErrorAt: now,
			lastErrorStep: job.step,
			status: isExhausted ? 'failed' : 'retrying',
			updatedAt: now,
		});
		// The step only: the error text stays on the job row.
		logError('[workspace deletion] transaction failed', {
			generation: job.generation,
			step: job.step,
			attempts,
			isExhausted,
		});
		if (!isExhausted) {
			await scheduleDeletionDrive(ctx, jobId, RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[0]);
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
		if (!job) return { isRestarted: false };
		const now = Date.now();
		const idleMs = now - job.updatedAt;
		const isFailed = job.status === 'failed';
		if (idleMs < (isFailed ? FAILED_DELETION_RETRY_AFTER_MS : DELETION_STALLED_AFTER_MS)) {
			return { isRestarted: false };
		}
		await ctx.db.patch(job._id, {
			status: 'running',
			updatedAt: now,
			...(isFailed ? { attempts: 0 } : {}),
		});
		await scheduleDeletionDrive(ctx, job._id);
		return { isRestarted: true };
	},
});

/** The active deletion job, else the most recent one, else `null`. */
export const status = internalQuery({
	args: {},
	handler: async (ctx): Promise<DeletionJobSummary | null> => {
		const job = await readLatestDeletionJob(ctx.db);
		return job ? summarizeDeletionJob(job) : null;
	},
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
 * walk into a job at the table the hop would have continued with, so the rest
 * of it is fenced, checkpointed and verified. When a job already exists its
 * chain owns progress and the hop stops after its batch.
 */
export const runStep = internalMutation({
	args: { table: organizationDeletionTableValidator },
	handler: async (ctx, { table }): Promise<void> => {
		const { hasMore } = await ORGANIZATION_DELETION_STEPS[table].deleteBatch(ctx);
		if (await readActiveWorkspaceDeletion(ctx.db)) return;
		const resumeAt = hasMore ? table : nextTable(table);
		await beginWorkspaceDeletion(
			ctx,
			{ source: 'previous_release' },
			resumeAt === null
				? { phase: 'verify', step: STEPS[STEPS.length - 1] ?? STEPS[0] }
				: { phase: 'sweep', step: resumeAt }
		);
	},
});
