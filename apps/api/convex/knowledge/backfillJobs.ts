/**
 * Shared job lifecycle for the two one-shot knowledge backfills:
 *   - `knowledgeBackfillJobs`     — message extraction (knowledge/messageBackfill.ts),
 *     started by the first explicit enable of `ai.agent`;
 *   - `knowledgeEdgeBackfillJobs` — graph edge inference (knowledge/edgeBackfill.ts),
 *     started by the first explicit enable of `ai.knowledge.autoLink`.
 *
 * Both tables share the same lifecycle columns (status, triggeredBy, totalCount,
 * scannedCount, startedAt, updatedAt, finishedAt, errorMessage) and differ only
 * in their counters and cursor. Everything here is a plain helper over that
 * shared shape; the Convex functions stay in the two backfill modules.
 *
 * First-run gate: a job in ANY status (including 'failed' or 'cancelled') means
 * the backfill has run, so re-enabling the flag never starts a second one.
 */

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { WithoutSystemFields } from 'convex/server';
import { recordAuditLog, type AuditAction, type AuditResource } from '../lib/auditLog';

export type BackfillJobTable = 'knowledgeBackfillJobs' | 'knowledgeEdgeBackfillJobs';

/**
 * Capped count of the walked table, used purely as the progress-bar
 * denominator. The walkers page by cursor, so they are never limited by it.
 */
const TOTAL_COUNT_CAP = 10000;

/**
 * A running job whose `updatedAt` is older than this is presumed dead: both
 * walkers bump `updatedAt` on every chunk, and one chunk finishes in well
 * under this window (the message walker is an action capped far below an
 * hour; the edge walker is a single mutation per page).
 */
export const STALE_RUNNING_JOB_MS = 60 * 60 * 1000;

/** Error note written on a job the stale sweep marks as failed. */
const STALE_JOB_ERROR =
	'The backfill stopped making progress and was marked as failed by the daily sweep.';

/** Per-table counters beyond the shared `scannedCount`. */
type ExtraCounters<T extends BackfillJobTable> = Omit<
	WithoutSystemFields<Doc<T>>,
	| 'status'
	| 'triggeredBy'
	| 'totalCount'
	| 'scannedCount'
	| 'startedAt'
	| 'updatedAt'
	| 'finishedAt'
	| 'errorMessage'
	| 'cursor'
	| 'cursorReceivedAt'
	| 'cursorId'
>;

/** True iff any job of this backfill (in any status) has ever been created. */
export async function hasAnyJob(ctx: QueryCtx, table: BackfillJobTable): Promise<boolean> {
	const existing = await ctx.db.query(table).take(1);
	return existing.length > 0;
}

/**
 * Insert a new running job, with `totalCount` taken as a capped count of
 * `countTable` (the rows the walker will page through).
 */
export async function createCappedJob<T extends BackfillJobTable>(
	ctx: MutationCtx,
	opts: {
		table: T;
		countTable: 'inboundMessages' | 'knowledgeEntries';
		triggeredBy: string;
		extraCounters: ExtraCounters<T>;
	}
): Promise<Id<T>> {
	const counted = await ctx.db.query(opts.countTable).take(TOTAL_COUNT_CAP);
	const now = Date.now();
	// TypeScript cannot relate a spread over a generic table's fields back to
	// that table's document type. `extraCounters` is already checked per table
	// at the call site, and the shared columns are identical in both schemas.
	const row = {
		...opts.extraCounters,
		status: 'running' as const,
		triggeredBy: opts.triggeredBy,
		totalCount: counted.length,
		scannedCount: 0,
		startedAt: now,
		updatedAt: now,
	} as unknown as WithoutSystemFields<Doc<T>>;
	return (await ctx.db.insert(opts.table, row)) as Id<T>;
}

/** Most recently started job of this backfill, or null. */
export async function latestJob<T extends BackfillJobTable>(
	ctx: QueryCtx,
	table: T
): Promise<Doc<T> | null> {
	const jobs = await ctx.db.query(table).withIndex('by_started_at').order('desc').take(1);
	return (jobs[0] as Doc<T> | undefined) ?? null;
}

/**
 * Cancel the latest job when it is still pending or running, and audit it.
 * The walker sees the 'cancelled' status on its next chunk and exits.
 * Returns false when there is nothing to cancel.
 */
export async function cancelLatestJob(
	ctx: MutationCtx,
	opts: {
		table: BackfillJobTable;
		userId: string;
		auditAction: AuditAction;
		auditResource: AuditResource;
	}
): Promise<boolean> {
	const job = await latestJob(ctx, opts.table);
	if (!job) return false;
	if (job.status !== 'pending' && job.status !== 'running') return false;

	const now = Date.now();
	await ctx.db.patch(job._id, {
		status: 'cancelled',
		finishedAt: now,
		updatedAt: now,
	});

	await recordAuditLog(ctx, {
		userId: opts.userId,
		action: opts.auditAction,
		resource: opts.auditResource,
		details: { jobId: job._id },
	});

	return true;
}

/**
 * First-run kick-off shared by the two flag toggles: when no job of this
 * backfill has ever existed, create one, schedule its first chunk and audit
 * the start. Returns the new job id, or null when the gate is closed.
 */
export async function startFirstRunBackfill<T extends BackfillJobTable>(
	ctx: MutationCtx,
	opts: {
		table: T;
		triggeredBy: string;
		create: () => Promise<Id<T>>;
		schedule: (jobId: Id<T>) => Promise<unknown>;
		audit: { action: AuditAction; resource: AuditResource };
	}
): Promise<Id<T> | null> {
	if (await hasAnyJob(ctx, opts.table)) return null;
	const jobId = await opts.create();
	await opts.schedule(jobId);
	await recordAuditLog(ctx, {
		userId: opts.triggeredBy,
		action: opts.audit.action,
		resource: opts.audit.resource,
		details: { jobId },
	});
	return jobId;
}

/**
 * Mark every running job whose `updatedAt` is older than `staleMs` as failed.
 * The edge walker is a mutation, so a throw rolls back any in-transaction
 * 'failed' write and the job would otherwise stay 'running' forever; the
 * message walker can die the same way if its action is killed mid-chunk.
 * Returns how many jobs were marked.
 */
export async function failStaleRunningJobs(
	ctx: MutationCtx,
	table: BackfillJobTable,
	staleMs: number
): Promise<number> {
	const now = Date.now();
	const running = await ctx.db
		.query(table)
		.withIndex('by_status', (q) => q.eq('status', 'running'))
		.take(100); // bounded: first-run gated, so at most one job per table ever runs
	let failed = 0;
	for (const job of running) {
		if (now - job.updatedAt < staleMs) continue;
		await ctx.db.patch(job._id, {
			status: 'failed',
			finishedAt: now,
			updatedAt: now,
			errorMessage: STALE_JOB_ERROR,
		});
		failed++;
	}
	return failed;
}
