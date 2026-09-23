/**
 * Contact erasure walker — permanently deletes one contact as a chain of
 * bounded transactions, driven by a persisted `contactErasureJobs` row.
 *
 *   tick         one transaction: advance the phases within the row/byte
 *                budget, save the phase and cursor, or finish (delete the job
 *                row and the contact row together).
 *   drive        the action that chains ticks and reschedules itself. It exists
 *                so a failing tick can be RECORDED: a mutation that throws rolls
 *                back everything it wrote, including any note about the error.
 *   recordFailure  counts the attempt, keeps the last error on the job row, and
 *                schedules a retry with backoff, or marks the job `failed` once
 *                retries run out.
 *
 * `retention.ts` feeds it (expired soft-deletes) and restarts stalled and
 * failed jobs; `contacts.removeForTeam` starts one for a REST hard delete.
 * Two chains on one job are harmless — every tick is a serializable
 * transaction and every phase is idempotent — so restarting a job whose chain
 * might still be alive is always safe.
 */

import { v } from 'convex/values';
import { internalAction, internalMutation, type MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { logError } from '../../lib/runtimeLog';
import { ErasureBudget } from './budget';
import { advanceErasure, finishErasure, FIRST_ERASURE_PHASE } from './phases';

/** Rows one erasure transaction may read and write. */
export const ERASURE_ROWS_PER_TRANSACTION = 400;
/** Estimated document bytes one erasure transaction may read (platform cap: 16 MiB). */
const ERASURE_BYTES_PER_TRANSACTION = 4 * 1024 * 1024;
/** Ticks one `drive` invocation chains before it reschedules itself. */
const TICKS_PER_DRIVE = 20;
/** Backoff before retry N (1-based) of a failed transaction. */
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const MAX_ERROR_CHARS = 500;

type ErasureReason = Doc<'contactErasureJobs'>['reason'];
type TickOutcome = 'done' | 'more' | 'stopped';

/**
 * Create the job row for `contactId`, or return the existing one. A job that
 * gave up is re-armed. Returns whether a chain needs to be started.
 */
async function ensureJob(
	ctx: MutationCtx,
	contactId: Id<'contacts'>,
	reason: ErasureReason
): Promise<{ jobId: Id<'contactErasureJobs'>; needsDrive: boolean }> {
	const now = Date.now();
	const existing = await ctx.db
		.query('contactErasureJobs')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.first();
	if (existing) {
		if (existing.status !== 'failed') return { jobId: existing._id, needsDrive: false };
		await ctx.db.patch(existing._id, { status: 'running', attempts: 0, updatedAt: now });
		return { jobId: existing._id, needsDrive: true };
	}
	const jobId = await ctx.db.insert('contactErasureJobs', {
		contactId,
		reason,
		status: 'running',
		phase: FIRST_ERASURE_PHASE,
		rowsProcessed: 0,
		transactions: 0,
		attempts: 0,
		createdAt: now,
		updatedAt: now,
	});
	return { jobId, needsDrive: true };
}

async function scheduleDrive(
	ctx: MutationCtx,
	jobId: Id<'contactErasureJobs'>,
	delayMs = 0
): Promise<void> {
	await ctx.scheduler.runAfter(delayMs, internal.contacts.erasure.walker.drive, { jobId });
}

/**
 * Start (or re-arm) the erasure of a contact that is already soft-deleted, and
 * schedule its chain. Idempotent: a job already under way is left alone.
 * Returns whether a new chain was started.
 */
export async function startContactErasure(
	ctx: MutationCtx,
	contactId: Id<'contacts'>,
	reason: ErasureReason
): Promise<boolean> {
	const { jobId, needsDrive } = await ensureJob(ctx, contactId, reason);
	if (needsDrive) await scheduleDrive(ctx, jobId);
	return needsDrive;
}

/**
 * Start the erasure and run its first transaction inside the caller's own, so
 * an ordinary contact is gone when the caller returns and only a large history
 * continues in the background. The contact must already be soft-deleted:
 * that hides it from every read and reclaims its identifiers while the rest
 * of the walk runs.
 */
export async function eraseContactNow(
	ctx: MutationCtx,
	contactId: Id<'contacts'>,
	reason: ErasureReason
): Promise<void> {
	const { jobId } = await ensureJob(ctx, contactId, reason);
	if ((await runErasureTransaction(ctx, jobId)) === 'more') await scheduleDrive(ctx, jobId);
}

/** One bounded erasure transaction for `jobId`. */
async function runErasureTransaction(
	ctx: MutationCtx,
	jobId: Id<'contactErasureJobs'>
): Promise<TickOutcome> {
	const job = await ctx.db.get(jobId);
	// A failed job only moves again once the sweep re-arms it.
	if (!job || job.status === 'failed') return 'stopped';

	const budget = new ErasureBudget(ERASURE_ROWS_PER_TRANSACTION, ERASURE_BYTES_PER_TRANSACTION);
	const progress = await advanceErasure(
		ctx,
		job.contactId,
		{ phase: job.phase, cursor: job.cursor },
		budget,
		'walker'
	);
	if (progress.isComplete) {
		// Counted out of the contact total when it was soft-deleted.
		await finishErasure(ctx, job.contactId, { decrementCount: false });
		return 'done';
	}
	await ctx.db.patch(jobId, {
		phase: progress.phase,
		cursor: progress.cursor,
		rowsProcessed: job.rowsProcessed + budget.rows,
		transactions: job.transactions + 1,
		status: 'running',
		attempts: 0,
		updatedAt: Date.now(),
	});
	return 'more';
}

export const tick = internalMutation({
	args: { jobId: v.id('contactErasureJobs') },
	handler: async (ctx, { jobId }): Promise<TickOutcome> => runErasureTransaction(ctx, jobId),
});

export const drive = internalAction({
	args: { jobId: v.id('contactErasureJobs') },
	handler: async (ctx, { jobId }): Promise<void> => {
		for (let i = 0; i < TICKS_PER_DRIVE; i++) {
			let outcome: TickOutcome;
			try {
				outcome = await ctx.runMutation(internal.contacts.erasure.walker.tick, { jobId });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await ctx.runMutation(internal.contacts.erasure.walker.recordFailure, {
					jobId,
					error: message.slice(0, MAX_ERROR_CHARS),
				});
				return;
			}
			if (outcome !== 'more') return;
		}
		await ctx.scheduler.runAfter(0, internal.contacts.erasure.walker.drive, { jobId });
	},
});

export const recordFailure = internalMutation({
	args: { jobId: v.id('contactErasureJobs'), error: v.string() },
	handler: async (ctx, { jobId, error }): Promise<void> => {
		const job = await ctx.db.get(jobId);
		if (!job) return;
		const attempts = job.attempts + 1;
		const isExhausted = attempts >= MAX_ATTEMPTS;
		const now = Date.now();
		await ctx.db.patch(jobId, {
			attempts,
			lastError: error.slice(0, MAX_ERROR_CHARS),
			lastErrorAt: now,
			status: isExhausted ? 'failed' : 'retrying',
			updatedAt: now,
		});
		// Ids and the phase only: the error text stays on the job row.
		logError('[contacts] erasure transaction failed', {
			jobId,
			phase: job.phase,
			attempts,
			isExhausted,
		});
		if (!isExhausted) {
			await scheduleDrive(ctx, jobId, RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[0]);
		}
	},
});
