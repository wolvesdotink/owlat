/**
 * Contact property deletion (#918): removes a custom property and its whole
 * value column as a chain of bounded transactions, driven by a persisted
 * `contactPropertyDeletionJobs` row.
 *
 *   requestPropertyDeletion  marks the property (`deletionRequestedAt`: hidden
 *                  from pickers, closed to value writes), creates its job and
 *                  runs the first batch in the caller's transaction, so an empty
 *                  or small property is gone when `remove` returns. A repeated
 *                  request joins the job under way; one for a failed or stalled
 *                  job re-arms it.
 *   tick           one transaction: delete up to a page of values through
 *                  `by_property`, bounded by rows and by bytes read. The batch
 *                  that reaches the end of the range also deletes the property
 *                  and the job, so no value outlives its definition.
 *   drive          the action that chains ticks and reschedules itself, so a
 *                  failing tick can be recorded (a throwing mutation rolls back
 *                  its own note about the error).
 *   recordFailure  counts the attempt, keeps the last error, retries with
 *                  backoff, and after the last retry marks the job `failed`.
 *   resumeStalled  hourly cron: restarts chains that went quiet and re-arms
 *                  failed jobs.
 *
 * Deleted values leave the index range, so every batch reads the range from the
 * start and needs no cursor; a rerun after a crash, or a second chain on the
 * same job, is harmless. Progress lives on the job row, not on the property, so
 * a value writer that reads the property row only conflicts with the request
 * and the final batch. Writers refuse a property under deletion
 * (`requireWritableProperty`, the import catalog); because they read the row,
 * a write racing the final batch is retried against the deleted property
 * instead of leaving an orphan value.
 */

import { v } from 'convex/values';
import { internalAction, type MutationCtx, type QueryCtx } from '../_generated/server';
import { internalMutation, readActiveWorkspaceDeletion } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { logError } from '../lib/runtimeLog';
import { throwInvalidState, throwNotFound } from '../_utils/errors';
import { isTransactionLimitError } from '../lib/convexLimitErrors';

type Job = Doc<'contactPropertyDeletionJobs'>;
type TickOutcome = 'done' | 'more' | 'stopped';

/** Values one deletion transaction may read and delete. */
export const PROPERTY_VALUES_PER_TRANSACTION = 1000;
/**
 * Bytes one deletion transaction may read from the value range. A quarter of
 * the 16 MiB platform ceiling, like the contact-erasure walker's budget.
 */
export const PROPERTY_DELETION_BYTES_PER_TRANSACTION = 4 * 1024 * 1024;
/** Ticks one `drive` invocation chains before it reschedules itself. */
const TICKS_PER_DRIVE = 20;
/** Backoff before retry N (1-based) of a failed transaction. */
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const MAX_ERROR_CHARS = 500;
/** A `running` or `retrying` job untouched this long has lost its chain. */
const STALLED_AFTER_MS = 30 * 60 * 1000;
/** Stalled or failed jobs restarted per sweep, per status. */
const RESTARTS_PER_SWEEP = 50;

/** Whether the property is being deleted (hidden, closed to value writes). */
export function isPropertyPendingDeletion(property: Doc<'contactProperties'>): boolean {
	return property.deletionRequestedAt !== undefined;
}

/**
 * The property a value write targets: it must exist and must not be under
 * deletion. Reading the row here is also what makes a write that races the
 * final batch conflict with it.
 */
export async function requireWritableProperty(
	ctx: Pick<MutationCtx, 'db'>,
	propertyId: Id<'contactProperties'>
): Promise<Doc<'contactProperties'>> {
	const property = await ctx.db.get(propertyId);
	if (!property) throwNotFound('Property');
	if (isPropertyPendingDeletion(property)) {
		throwInvalidState(`Property "${property.key}" is being deleted`, { propertyId });
	}
	return property;
}

/** The row cap after a batch under `rowCap` commits: doubled, until full. */
function widenedRowCap(rowCap: number | undefined): number | undefined {
	if (rowCap === undefined) return undefined;
	const next = rowCap * 2;
	return next >= PROPERTY_VALUES_PER_TRANSACTION ? undefined : next;
}

async function scheduleDrive(
	ctx: MutationCtx,
	jobId: Id<'contactPropertyDeletionJobs'>,
	delayMs = 0
): Promise<void> {
	await ctx.scheduler.runAfter(delayMs, internal.contacts.propertyDeletion.drive, { jobId });
}

async function findJob(
	ctx: Pick<QueryCtx, 'db'>,
	propertyId: Id<'contactProperties'>
): Promise<Job | null> {
	return await ctx.db
		.query('contactPropertyDeletionJobs')
		.withIndex('by_property', (q) => q.eq('propertyId', propertyId))
		.first();
}

/** One bounded deletion transaction for `jobId`. */
async function runDeletionTransaction(
	ctx: MutationCtx,
	jobId: Id<'contactPropertyDeletionJobs'>
): Promise<TickOutcome> {
	const job = await ctx.db.get(jobId);
	// A failed job only moves again once it is re-armed.
	if (!job || job.status === 'failed') return 'stopped';

	const page = await ctx.db
		.query('contactPropertyValues')
		.withIndex('by_property', (q) => q.eq('propertyId', job.propertyId))
		.paginate({
			numItems: job.rowCap ?? PROPERTY_VALUES_PER_TRANSACTION,
			cursor: null,
			maximumBytesRead: PROPERTY_DELETION_BYTES_PER_TRANSACTION,
		});
	for (const value of page.page) {
		await ctx.db.delete(value._id);
	}
	if (page.isDone) {
		// The range is empty as of this transaction: the definition and the job
		// go with the last values.
		if (await ctx.db.get(job.propertyId)) await ctx.db.delete(job.propertyId);
		await ctx.db.delete(jobId);
		return 'done';
	}
	await ctx.db.patch(jobId, {
		status: 'running',
		valuesDeleted: job.valuesDeleted + page.page.length,
		transactions: job.transactions + 1,
		attempts: 0,
		rowCap: widenedRowCap(job.rowCap),
		updatedAt: Date.now(),
	});
	return 'more';
}

/** Put a failed or stalled job back to work and start a chain on it. */
async function rearm(ctx: MutationCtx, job: Job, now: number): Promise<void> {
	await ctx.db.patch(job._id, {
		status: 'running',
		updatedAt: now,
		...(job.status === 'failed' ? { attempts: 0 } : {}),
	});
	await scheduleDrive(ctx, job._id);
}

/**
 * Start deleting `property`, or join the deletion already under way. Returns
 * `deleted` when the first batch finished the job inside this transaction,
 * `pending` when the rest continues in the background. `requestedBy` is the
 * caller's session user, recorded on the job.
 */
export async function requestPropertyDeletion(
	ctx: MutationCtx,
	property: Doc<'contactProperties'>,
	requestedBy: string
): Promise<'deleted' | 'pending'> {
	const now = Date.now();
	const existing = await findJob(ctx, property._id);
	if (existing) {
		if (existing.status === 'failed' || existing.updatedAt < now - STALLED_AFTER_MS) {
			await rearm(ctx, existing, now);
		}
		return 'pending';
	}
	if (!isPropertyPendingDeletion(property)) {
		await ctx.db.patch(property._id, { deletionRequestedAt: now });
	}
	const jobId = await ctx.db.insert('contactPropertyDeletionJobs', {
		propertyId: property._id,
		requestedBy,
		status: 'running',
		valuesDeleted: 0,
		transactions: 0,
		attempts: 0,
		createdAt: now,
		updatedAt: now,
	});
	if ((await runDeletionTransaction(ctx, jobId)) === 'done') return 'deleted';
	await scheduleDrive(ctx, jobId);
	return 'pending';
}

/** What the admin page shows of a job (no error text, no requester). */
export type PropertyDeletionView = {
	status: Job['status'];
	valuesDeleted: number;
	requestedAt: number;
};

export async function readPropertyDeletion(
	ctx: Pick<QueryCtx, 'db'>,
	propertyId: Id<'contactProperties'>
): Promise<PropertyDeletionView | null> {
	const job = await findJob(ctx, propertyId);
	if (!job) return null;
	return { status: job.status, valuesDeleted: job.valuesDeleted, requestedAt: job.createdAt };
}

export const tick = internalMutation({
	args: { jobId: v.id('contactPropertyDeletionJobs') },
	handler: async (ctx, { jobId }): Promise<TickOutcome> => runDeletionTransaction(ctx, jobId),
});

export const drive = internalAction({
	args: { jobId: v.id('contactPropertyDeletionJobs') },
	handler: async (ctx, { jobId }): Promise<void> => {
		for (let i = 0; i < TICKS_PER_DRIVE; i++) {
			let outcome: TickOutcome;
			try {
				outcome = await ctx.runMutation(internal.contacts.propertyDeletion.tick, { jobId });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await ctx.runMutation(internal.contacts.propertyDeletion.recordFailure, {
					jobId,
					error: message.slice(0, MAX_ERROR_CHARS),
				});
				return;
			}
			if (outcome !== 'more') return;
		}
		await ctx.scheduler.runAfter(0, internal.contacts.propertyDeletion.drive, { jobId });
	},
});

export const recordFailure = internalMutation({
	args: { jobId: v.id('contactPropertyDeletionJobs'), error: v.string() },
	handler: async (ctx, { jobId, error }): Promise<void> => {
		const job = await ctx.db.get(jobId);
		if (!job) return;
		const attempts = job.attempts + 1;
		const isExhausted = attempts >= MAX_ATTEMPTS;
		const isLimit = isTransactionLimitError(error);
		const now = Date.now();
		await ctx.db.patch(jobId, {
			attempts,
			status: isExhausted ? 'failed' : 'retrying',
			lastError: error.slice(0, MAX_ERROR_CHARS),
			lastErrorAt: now,
			// Retry what failed a value at a time; it widens again as it commits.
			...(isLimit ? { rowCap: 1 } : {}),
			updatedAt: now,
		});
		// Ids and counters only: the error text stays on the job row.
		logError('[contacts] property deletion transaction failed', {
			jobId,
			propertyId: job.propertyId,
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

/**
 * Restart chains that went quiet (a crashed action, a lost schedule) and
 * re-arm failed jobs, so a job that keeps failing is retried hourly and stays
 * visible as `failed` in between.
 *
 * Not while a workspace deletion runs: it cancels the chains, so every job
 * looks stalled, and the write fence refuses the re-arm until the deletion
 * sweeps the job table. The deletion removes the jobs anyway.
 */
export const resumeStalled = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ restarted: number }> => {
		if (await readActiveWorkspaceDeletion(ctx.db)) return { restarted: 0 };
		const now = Date.now();
		let restarted = 0;
		for (const status of ['running', 'retrying', 'failed'] as const) {
			const stalled = await ctx.db
				.query('contactPropertyDeletionJobs')
				.withIndex('by_status_and_updated_at', (q) =>
					q.eq('status', status).lt('updatedAt', now - STALLED_AFTER_MS)
				)
				.take(RESTARTS_PER_SWEEP);
			for (const job of stalled) {
				await rearm(ctx, job, now);
				restarted += 1;
			}
		}
		return { restarted };
	},
});
