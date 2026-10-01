/**
 * Member erasure walker — erases one account as a chain of bounded
 * transactions, driven by a persisted `memberErasureJobs` row.
 *
 *   tick           one transaction: advance the current phase within the
 *                  row/byte budget and save where it stopped TOGETHER with
 *                  scheduling the next step, or, after the last phase, verify
 *                  the end state and finish (delete the job row, mark the
 *                  request `completed`).
 *   drive          the action that runs one tick. It exists so a failing tick
 *                  can be RECORDED: a mutation that throws rolls back
 *                  everything it wrote, including any note about the error.
 *   recordFailure  counts the attempt, keeps the last error on the job row and
 *                  schedules a retry with backoff, or marks the job and its
 *                  request `failed` once retries run out.
 *
 * Every scheduled step carries the job's current `lease`; a step holding an
 * older one does nothing. The stall sweep (`lifecycle.ts`) can therefore
 * restart a job whose chain might still be alive without two chains racing.
 *
 * A transaction that hits a platform limit is retried at one row per
 * transaction, doubling back with every one that commits, the same recovery
 * the contact erasure uses (`contacts/erasure/walker.ts`).
 */

import { v } from 'convex/values';
import { internalAction, type MutationCtx } from '../../_generated/server';
import { internalMutation, readActiveWorkspaceDeletion } from '../../lib/writeFence';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { logError } from '../../lib/runtimeLog';
import { ErasureBudget } from '../../contacts/erasure/budget';
import {
	ERASURE_BYTES_PER_TRANSACTION,
	ERASURE_ROWS_PER_TRANSACTION,
} from '../../contacts/erasure/walker';
import { isTransactionLimitError } from '../../lib/convexLimitErrors';
import { advanceMemberErasure, FIRST_MEMBER_ERASURE_PHASE, remainingMemberData } from './phases';
import { scheduleDrive } from './schedule';

/** Backoff before retry N (1-based) of a failed transaction. */
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** How long a job waits before looking again at a running workspace deletion. */
export const WORKSPACE_DELETION_WAIT_MS = 10 * 60 * 1000;
/** Full walks whose end-state check may fail before the job gives up. */
const MAX_VERIFICATION_PASSES = 3;
const MAX_ERROR_CHARS = 500;

type TickOutcome = 'done' | 'more' | 'waiting' | 'stopped';

/** The row cap after a transaction under `rowCap` commits: doubled, until full. */
function widenedRowCap(rowCap: number | undefined): number | undefined {
	if (rowCap === undefined) return undefined;
	const next = rowCap * 2;
	return next >= ERASURE_ROWS_PER_TRANSACTION ? undefined : next;
}

/** Close the request: the erasure ran every phase and its end state checked out. */
async function completeRequest(
	ctx: MutationCtx,
	requestId: Id<'accountDeletionRequests'>
): Promise<void> {
	const request = await ctx.db.get(requestId);
	if (!request || request.status === 'completed') return;
	await ctx.db.patch(requestId, {
		status: 'completed',
		statusChangedAt: Date.now(),
		lastError: undefined,
	});
}

/** Mark the job and its request `failed`, keeping the reason on both. */
async function failJob(ctx: MutationCtx, job: Doc<'memberErasureJobs'>, error: string) {
	const now = Date.now();
	const lastError = error.slice(0, MAX_ERROR_CHARS);
	await ctx.db.patch(job._id, { status: 'failed', lastError, lastErrorAt: now, updatedAt: now });
	const request = await ctx.db.get(job.requestId);
	if (request && request.status !== 'completed') {
		await ctx.db.patch(job.requestId, { status: 'failed', lastError, statusChangedAt: now });
	}
}

/** One bounded erasure transaction for `jobId`, as the chain holding `lease`. */
async function runErasureTransaction(
	ctx: MutationCtx,
	jobId: Id<'memberErasureJobs'>,
	lease: string | undefined
): Promise<TickOutcome> {
	const job = await ctx.db.get(jobId);
	// A failed job only moves again once the sweep (or an operator) re-arms it.
	if (!job || job.status === 'failed') return 'stopped';
	if (lease !== undefined && job.lease !== lease) return 'stopped';

	const now = Date.now();
	const budget = new ErasureBudget(
		job.rowCap ?? ERASURE_ROWS_PER_TRANSACTION,
		ERASURE_BYTES_PER_TRANSACTION
	);
	const isWorkspaceBeingDeleted = (await readActiveWorkspaceDeletion(ctx.db)) !== null;
	const subject = { authUserId: job.authUserId, email: job.email };
	const progress = await advanceMemberErasure(
		ctx,
		subject,
		{ phase: job.phase, cursor: job.cursor },
		budget,
		isWorkspaceBeingDeleted
	);
	const committed = {
		rowsProcessed: job.rowsProcessed + budget.rows,
		transactions: job.transactions + 1,
		status: 'running' as const,
		attempts: 0,
		rowCap: widenedRowCap(job.rowCap),
		updatedAt: now,
	};

	if (progress.state === 'waiting') {
		await ctx.db.patch(jobId, {
			...committed,
			phase: progress.phase,
			cursor: undefined,
			isWaitingForWorkspaceDeletion: true,
		});
		await scheduleDrive(ctx, jobId, WORKSPACE_DELETION_WAIT_MS);
		return 'waiting';
	}
	if (progress.state === 'more') {
		await ctx.db.patch(jobId, {
			...committed,
			phase: progress.phase,
			cursor: progress.cursor,
			isWaitingForWorkspaceDeletion: undefined,
		});
		await scheduleDrive(ctx, jobId);
		return 'more';
	}

	// Every phase ran. Complete only if nothing the erasure removes is left: a
	// writer that raced the walk (a sync commit, a late insert) sends it round
	// again instead of into a false `completed`.
	const remaining = await remainingMemberData(ctx, subject);
	if (remaining.length > 0) {
		const passes = (job.verificationPasses ?? 0) + 1;
		if (passes >= MAX_VERIFICATION_PASSES) {
			await ctx.db.patch(jobId, { ...committed, verificationPasses: passes });
			await failJob(ctx, job, `End-state check failed; still present: ${remaining.join(', ')}`);
			return 'stopped';
		}
		await ctx.db.patch(jobId, {
			...committed,
			phase: FIRST_MEMBER_ERASURE_PHASE,
			cursor: undefined,
			verificationPasses: passes,
			isWaitingForWorkspaceDeletion: undefined,
		});
		await scheduleDrive(ctx, jobId);
		return 'more';
	}
	await ctx.db.delete(jobId);
	await completeRequest(ctx, job.requestId);
	return 'done';
}

export const tick = internalMutation({
	args: { jobId: v.id('memberErasureJobs'), lease: v.optional(v.string()) },
	handler: async (ctx, { jobId, lease }): Promise<TickOutcome> =>
		runErasureTransaction(ctx, jobId, lease),
});

export const drive = internalAction({
	args: { jobId: v.id('memberErasureJobs'), lease: v.optional(v.string()) },
	handler: async (ctx, { jobId, lease }): Promise<void> => {
		try {
			await ctx.runMutation(internal.auth.erasure.walker.tick, { jobId, lease });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await ctx.runMutation(internal.auth.erasure.walker.recordFailure, {
				jobId,
				lease,
				error: message.slice(0, MAX_ERROR_CHARS),
			});
		}
	},
});

export const recordFailure = internalMutation({
	args: {
		jobId: v.id('memberErasureJobs'),
		lease: v.optional(v.string()),
		error: v.string(),
	},
	handler: async (ctx, { jobId, lease, error }): Promise<void> => {
		const job = await ctx.db.get(jobId);
		if (!job || job.status === 'failed') return;
		if (lease !== undefined && job.lease !== lease) return;
		const attempts = job.attempts + 1;
		const isExhausted = attempts >= MAX_ATTEMPTS;
		const isLimit = isTransactionLimitError(error);
		const now = Date.now();
		await ctx.db.patch(jobId, {
			attempts,
			lastError: error.slice(0, MAX_ERROR_CHARS),
			lastErrorAt: now,
			status: isExhausted ? 'failed' : 'retrying',
			// Retry what failed a row at a time; it widens again as it commits.
			...(isLimit ? { rowCap: 1 } : {}),
			updatedAt: now,
		});
		// Ids and the phase only: the error text stays on the job row.
		logError('[auth] member erasure transaction failed', {
			jobId,
			phase: job.phase,
			attempts,
			isExhausted,
			isLimit,
		});
		if (isExhausted) {
			await failJob(ctx, { ...job, attempts }, error);
			return;
		}
		await scheduleDrive(ctx, jobId, RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[0]);
	},
});
