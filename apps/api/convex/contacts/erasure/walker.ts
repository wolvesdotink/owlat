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
 * The budget keeps every transaction inside the platform limits by
 * construction, but the limits of a given deployment are not known here. A
 * transaction that hits one anyway is retried at one row per transaction, and
 * the allowance doubles back with every transaction that commits, so a range
 * too large for the full budget is crossed rather than retried whole forever.
 * A job whose single-row transactions still hit a limit ends `failed` like any
 * other, keeps its one-row cap, and the daily sweep retries it from there.
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
/**
 * Document bytes one erasure transaction may read, counted before each read
 * at the maximum document size (see `budget.ts`). A quarter of the 16 MiB
 * platform ceiling: the rest covers reads the budget does not see (the job
 * and contact rows, counters) and deployments on the older 8 MiB ceiling.
 */
export const ERASURE_BYTES_PER_TRANSACTION = 4 * 1024 * 1024;
/** Ticks one `drive` invocation chains before it reschedules itself. */
const TICKS_PER_DRIVE = 20;
/** Backoff before retry N (1-based) of a failed transaction. */
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const MAX_ERROR_CHARS = 500;

type ErasureReason = Doc<'contactErasureJobs'>['reason'];
type TickOutcome = 'done' | 'more' | 'stopped';

/**
 * Whether a failed transaction ran into a per-transaction platform limit (data
 * or documents read or written). Convex reports those as plain errors worded
 * "... in a single function execution (limit: ...)", some with a link to its
 * limits page, so this reads the message. Timeouts and other errors are left
 * out: a retry at the same size may clear them.
 */
export function isTransactionLimitError(message: string): boolean {
	return /in a single function execution|docs\.convex\.dev\/production\/state\/limits/i.test(
		message
	);
}

/** The row cap after a transaction under `rowCap` commits: doubled, until full. */
function widenedRowCap(rowCap: number | undefined): number | undefined {
	if (rowCap === undefined) return undefined;
	const next = rowCap * 2;
	return next >= ERASURE_ROWS_PER_TRANSACTION ? undefined : next;
}

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

	const budget = new ErasureBudget(
		job.rowCap ?? ERASURE_ROWS_PER_TRANSACTION,
		ERASURE_BYTES_PER_TRANSACTION
	);
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
		rowCap: widenedRowCap(job.rowCap),
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
		logError('[contacts] erasure transaction failed', {
			jobId,
			phase: job.phase,
			attempts,
			isExhausted,
			isLimit,
			rowCap: job.rowCap,
		});
		if (!isExhausted) {
			await scheduleDrive(ctx, jobId, RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[0]);
		}
	},
});
