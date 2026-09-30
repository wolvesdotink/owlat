/**
 * The workspace deletion LIFECYCLE: the durable job the walker drives
 * (`walker.ts`) and the transactions it is made of.
 *
 *   begin      one transaction: open the singleton job (or join the one in
 *              progress). From its commit on, the write fence refuses every
 *              write that would put data back into a swept table.
 *   quiesce    cancel the workspace's pending scheduled functions, a bounded
 *              page per transaction (`quiesce.ts`).
 *   sweep      one transaction per bounded batch of the current step's table;
 *              the progress row saves the step after each, so a crash, a failed
 *              attempt or a redeploy resumes where the last batch left off.
 *   verify     with the fence still up, re-scan the scheduler, then check that
 *              every registered table is empty. A table that is not goes back to
 *              sweeping; only an empty pass completes the job, and completing it
 *              is what lifts the fence.
 *
 * The job row is the fence and changes only when a generation opens and ends;
 * everything a transaction advances lives on the job's progress row.
 *
 * The ordered table list and the per-table steps are data (`steps/registry.ts`);
 * this module owns only the lifecycle around them.
 */

import type { DatabaseReader, MutationCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { recordAuditLog } from '../../lib/auditLog';
import { logInfo, logWarn } from '../../lib/runtimeLog';
import { readActiveWorkspaceDeletion, type WorkspaceDeletionJob } from '../../lib/writeFence';
import { cancelPendingScheduledFunctions } from './quiesce';
import type { OrganizationDeletionTable } from './steps/_common';
import { ORGANIZATION_DELETION_STEPS, STEPS } from './steps/registry';

export type WorkspaceDeletionSource = WorkspaceDeletionJob['source'];
export type WorkspaceDeletionProgress = Doc<'workspaceDeletionProgress'>;
export type DeletionTickOutcome = 'more' | 'done' | 'stopped';

/**
 * Verification passes that may still find rows before the job gives up. Each
 * one means something wrote behind the sweep; with every writer fenced that
 * should never repeat, so a job that keeps finding rows fails loudly instead of
 * looping with the fence up forever.
 */
export const MAX_VERIFY_PASSES = 5;

const STEP_TABLES: ReadonlySet<string> = new Set(STEPS);

function isDeletionTable(step: string): step is OrganizationDeletionTable {
	return STEP_TABLES.has(step);
}

/**
 * Returns the next table after `table` in `STEPS`, or `null` if `table` is the
 * last one.
 */
export function nextTable(table: OrganizationDeletionTable): OrganizationDeletionTable | null {
	const idx = STEPS.indexOf(table);
	if (idx === -1 || idx === STEPS.length - 1) return null;
	return STEPS[idx + 1] ?? null;
}

async function latestJob(db: DatabaseReader): Promise<WorkspaceDeletionJob | null> {
	return await db.query('workspaceDeletionJobs').withIndex('by_generation').order('desc').first();
}

export async function readDeletionProgress(
	db: DatabaseReader,
	jobId: Id<'workspaceDeletionJobs'>
): Promise<WorkspaceDeletionProgress | null> {
	return await db
		.query('workspaceDeletionProgress')
		.withIndex('by_job', (q) => q.eq('jobId', jobId))
		.unique();
}

export async function scheduleDeletionDrive(
	ctx: MutationCtx,
	jobId: Id<'workspaceDeletionJobs'>,
	delayMs = 0
): Promise<void> {
	await ctx.scheduler.runAfter(delayMs, internal.workspaces.deletion.walker.drive, { jobId });
}

/**
 * Put a `failed` job back to work. A job that failed verification already had
 * its checkpoint moved to the table the rows kept reappearing in, so it resumes
 * by sweeping that table; the pass count starts again so it gets a full budget
 * of verification passes.
 */
export async function rearmWorkspaceDeletion(
	ctx: MutationCtx,
	progress: WorkspaceDeletionProgress,
	now: number
): Promise<void> {
	await ctx.db.patch(progress._id, {
		status: 'running',
		attempts: 0,
		verifyPasses: 0,
		rearms: progress.rearms + 1,
		updatedAt: now,
	});
	await scheduleDeletionDrive(ctx, progress.jobId);
}

export interface WorkspaceDeletionBegin {
	jobId: Id<'workspaceDeletionJobs'>;
	generation: number;
	/** True when the request joined a job that was already in progress. */
	isJoined: boolean;
}

/**
 * Enter the deletion lifecycle, atomically with the caller's transaction.
 *
 * At most one job is active. Two concurrent requests both read the empty
 * `by_is_active` range; the first to commit inserts into it, which conflicts
 * with the second, and the second's re-run finds the job and joins it. So a
 * second request can never start a second generation. Joining a job that ran
 * out of retries re-arms it.
 *
 * `resumeAt` is the table the sweep starts from once the scheduler is quiet:
 * the first one, or wherever a previous release's walk had got to.
 */
export async function beginWorkspaceDeletion(
	ctx: MutationCtx,
	request: { source: WorkspaceDeletionSource; requestedBy?: string },
	resumeAt: OrganizationDeletionTable = STEPS[0]
): Promise<WorkspaceDeletionBegin> {
	const now = Date.now();
	const active = await readActiveWorkspaceDeletion(ctx.db);
	if (active) {
		const progress = await readDeletionProgress(ctx.db, active._id);
		if (progress) {
			await ctx.db.patch(progress._id, { joinedRequests: progress.joinedRequests + 1 });
			if (progress.status === 'failed') await rearmWorkspaceDeletion(ctx, progress, now);
		}
		return { jobId: active._id, generation: active.generation, isJoined: true };
	}

	const generation = ((await latestJob(ctx.db))?.generation ?? 0) + 1;
	const jobId = await ctx.db.insert('workspaceDeletionJobs', {
		generation,
		isActive: true,
		source: request.source,
		...(request.requestedBy !== undefined ? { requestedBy: request.requestedBy } : {}),
		startedAt: now,
	});
	await ctx.db.insert('workspaceDeletionProgress', {
		jobId,
		status: 'running',
		phase: 'quiesce',
		step: resumeAt,
		scheduledCancelled: 0,
		joinedRequests: 0,
		rowsDeleted: 0,
		transactions: 0,
		verifyPasses: 0,
		rearms: 0,
		attempts: 0,
		updatedAt: now,
	});
	await scheduleDeletionDrive(ctx, jobId);
	logInfo('[workspace deletion] started', { generation, source: request.source });
	return { jobId, generation, isJoined: false };
}

/** The first registered table that still holds a row, in cascade order. */
async function firstNonEmptyTable(db: DatabaseReader): Promise<OrganizationDeletionTable | null> {
	for (const table of STEPS) {
		if ((await db.query(table).first()) !== null) return table;
	}
	return null;
}

/** Take the fence down: the job row's only write after it opened. */
async function endJob(
	ctx: MutationCtx,
	job: WorkspaceDeletionJob,
	outcome:
		| { outcome: 'completed' }
		| { outcome: 'aborted'; abortedBy: string; abortReason: string },
	now: number
): Promise<void> {
	await ctx.db.patch(job._id, { isActive: false, endedAt: now, ...outcome });
}

/**
 * One bounded transaction of job `jobId`: a scheduler page, a sweep batch or a
 * verification pass, followed by the checkpoint. The caller runs it on the RAW
 * mutation context: this is the one writer the fence exempts.
 */
export async function runWorkspaceDeletionTransaction(
	ctx: MutationCtx,
	jobId: Id<'workspaceDeletionJobs'>
): Promise<DeletionTickOutcome> {
	const job = await ctx.db.get(jobId);
	if (!job || !job.isActive) return 'stopped';
	const progress = await readDeletionProgress(ctx.db, jobId);
	// A failed job only moves again once it is re-armed (recovery or a new request).
	if (!progress || progress.status === 'failed') return 'stopped';
	const now = Date.now();
	const counted = {
		transactions: progress.transactions + 1,
		attempts: 0,
		status: 'running' as const,
		updatedAt: now,
	};

	if (progress.phase === 'quiesce' || progress.phase === 'verify') {
		const scan = await cancelPendingScheduledFunctions(ctx, progress.scheduledCursor);
		const scanned = {
			scheduledCancelled: progress.scheduledCancelled + scan.cancelled,
			...(scan.cursor !== undefined ? { scheduledCursor: scan.cursor } : {}),
		};
		if (!scan.isDone || progress.phase === 'quiesce') {
			await ctx.db.patch(progress._id, {
				...counted,
				...scanned,
				...(scan.isDone ? { phase: 'sweep' as const } : {}),
			});
			return 'more';
		}

		const leftover = await firstNonEmptyTable(ctx.db);
		if (leftover === null) {
			await endJob(ctx, job, { outcome: 'completed' }, now);
			await ctx.db.patch(progress._id, { ...counted, ...scanned, status: 'completed' });
			logInfo('[workspace deletion] completed', {
				generation: job.generation,
				rowsDeleted: progress.rowsDeleted,
				verifyPasses: progress.verifyPasses,
			});
			return 'done';
		}
		const verifyPasses = progress.verifyPasses + 1;
		const isExhausted = verifyPasses >= MAX_VERIFY_PASSES;
		// Either way the checkpoint moves to the table that still has rows: a
		// re-armed failed job resumes by sweeping it, not by re-verifying.
		await ctx.db.patch(progress._id, {
			...counted,
			...scanned,
			phase: 'sweep',
			step: leftover,
			verifyPasses,
			...(isExhausted
				? {
						status: 'failed' as const,
						lastError: `Rows kept reappearing in ${leftover} after ${verifyPasses} verification passes`,
						lastErrorAt: now,
						lastErrorStep: leftover,
					}
				: {}),
		});
		if (isExhausted) {
			logWarn('[workspace deletion] verification keeps finding rows', {
				generation: job.generation,
				table: leftover,
				verifyPasses,
			});
			return 'stopped';
		}
		return 'more';
	}

	const table = isDeletionTable(progress.step) ? progress.step : STEPS[0];
	const { deletedCount, hasMore } = await ORGANIZATION_DELETION_STEPS[table].deleteBatch(ctx);
	const next = hasMore ? table : nextTable(table);
	await ctx.db.patch(progress._id, {
		...counted,
		phase: next === null ? 'verify' : 'sweep',
		step: next ?? table,
		rowsDeleted: progress.rowsDeleted + deletedCount,
	});
	return 'more';
}

/**
 * The operator's way out: end the active job WITHOUT completing it, which
 * lifts the fence with whatever the sweep has not reached still in place. For a
 * job that cannot finish (a table that keeps refilling from a writer nobody can
 * stop) rather than leaving the deployment read-only. Recorded in the audit
 * log, which survives because the sweep stops here, and in the process log.
 *
 * It stops the deletion; it undoes nothing. Deleted rows stay deleted,
 * scheduled work the quiesce cancelled stays cancelled, and a non-owner
 * account deletion closed during the job is not reopened, so that member's
 * rows the sweep had not reached remain.
 */
export async function abortWorkspaceDeletion(
	ctx: MutationCtx,
	request: { operator: string; reason: string }
): Promise<{ generation: number } | null> {
	const job = await readActiveWorkspaceDeletion(ctx.db);
	if (!job) return null;
	const now = Date.now();
	const progress = await readDeletionProgress(ctx.db, job._id);
	await endJob(
		ctx,
		job,
		{ outcome: 'aborted', abortedBy: request.operator, abortReason: request.reason },
		now
	);
	if (progress) await ctx.db.patch(progress._id, { status: 'aborted', updatedAt: now });
	await recordAuditLog(ctx, {
		userId: request.operator,
		action: 'settings.workspace_deletion_aborted',
		resource: 'settings',
		detailsBlob: JSON.stringify({
			generation: job.generation,
			reason: request.reason,
			phase: progress?.phase ?? null,
			step: progress?.step ?? null,
		}),
	});
	logWarn('[workspace deletion] aborted by an operator; the fence is down', {
		generation: job.generation,
		phase: progress?.phase ?? null,
		step: progress?.step ?? null,
	});
	return { generation: job.generation };
}

export interface DeletionJobSummary {
	jobId: Id<'workspaceDeletionJobs'>;
	generation: number;
	isActive: boolean;
	status: WorkspaceDeletionProgress['status'];
	phase: WorkspaceDeletionProgress['phase'];
	step: string;
	source: WorkspaceDeletionSource;
	joinedRequests: number;
	rowsDeleted: number;
	transactions: number;
	scheduledCancelled: number;
	verifyPasses: number;
	rearms: number;
	attempts: number;
	lastError: string | null;
	lastErrorAt: number | null;
	lastErrorStep: string | null;
	startedAt: number;
	updatedAt: number;
	endedAt: number | null;
	abortedBy: string | null;
}

/** What an operator needs to see about a job. */
export function summarizeDeletionJob(
	job: WorkspaceDeletionJob,
	progress: WorkspaceDeletionProgress
): DeletionJobSummary {
	return {
		jobId: job._id,
		generation: job.generation,
		isActive: job.isActive,
		status: progress.status,
		phase: progress.phase,
		step: progress.step,
		source: job.source,
		joinedRequests: progress.joinedRequests,
		rowsDeleted: progress.rowsDeleted,
		transactions: progress.transactions,
		scheduledCancelled: progress.scheduledCancelled,
		verifyPasses: progress.verifyPasses,
		rearms: progress.rearms,
		attempts: progress.attempts,
		lastError: progress.lastError ?? null,
		lastErrorAt: progress.lastErrorAt ?? null,
		lastErrorStep: progress.lastErrorStep ?? null,
		startedAt: job.startedAt,
		updatedAt: progress.updatedAt,
		endedAt: job.endedAt ?? null,
		abortedBy: job.abortedBy ?? null,
	};
}

/** The active job, else the most recent one, else `null`, with its progress. */
export async function readLatestDeletionJob(
	db: DatabaseReader
): Promise<DeletionJobSummary | null> {
	const job = (await readActiveWorkspaceDeletion(db)) ?? (await latestJob(db));
	if (!job) return null;
	const progress = await readDeletionProgress(db, job._id);
	return progress ? summarizeDeletionJob(job, progress) : null;
}
