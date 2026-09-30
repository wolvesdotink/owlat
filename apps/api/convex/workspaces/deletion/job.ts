/**
 * The workspace deletion LIFECYCLE: the durable job the walker drives
 * (`walker.ts`) and the transactions it is made of.
 *
 *   begin      one transaction: open the singleton job (or join the one in
 *              progress). From its commit on, the write fence refuses every
 *              write that would put data back into a swept table.
 *   sweep      one transaction per bounded batch of the current step's table;
 *              the job row saves the step after each, so a crash, a failed
 *              attempt or a redeploy resumes where the last batch left off.
 *   verify     with the fence still up, check that every registered table is
 *              empty. A table that is not goes back to sweeping; only an empty
 *              pass completes the job, and completing it is what lifts the fence.
 *
 * The ordered table list and the per-table steps are data (`steps/registry.ts`);
 * this module owns only the lifecycle around them.
 */

import type { DatabaseReader, MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { logInfo, logWarn } from '../../lib/runtimeLog';
import { readActiveWorkspaceDeletion, type WorkspaceDeletionJob } from '../../lib/writeFence';
import type { OrganizationDeletionTable } from './steps/_common';
import { ORGANIZATION_DELETION_STEPS, STEPS } from './steps/registry';

export type WorkspaceDeletionSource = WorkspaceDeletionJob['source'];
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

async function latestGeneration(db: DatabaseReader): Promise<number> {
	const latest = await db
		.query('workspaceDeletionJobs')
		.withIndex('by_generation')
		.order('desc')
		.first();
	return latest?.generation ?? 0;
}

export async function scheduleDeletionDrive(
	ctx: MutationCtx,
	jobId: Id<'workspaceDeletionJobs'>,
	delayMs = 0
): Promise<void> {
	await ctx.scheduler.runAfter(delayMs, internal.workspaces.deletion.walker.drive, { jobId });
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
 */
export async function beginWorkspaceDeletion(
	ctx: MutationCtx,
	request: { source: WorkspaceDeletionSource; requestedBy?: string },
	resumeAt: { phase: WorkspaceDeletionJob['phase']; step: OrganizationDeletionTable } = {
		phase: 'sweep',
		step: STEPS[0],
	}
): Promise<WorkspaceDeletionBegin> {
	const now = Date.now();
	const active = await readActiveWorkspaceDeletion(ctx.db);
	if (active) {
		const isFailed = active.status === 'failed';
		await ctx.db.patch(active._id, {
			joinedRequests: active.joinedRequests + 1,
			...(isFailed ? { status: 'running' as const, attempts: 0, updatedAt: now } : {}),
		});
		if (isFailed) await scheduleDeletionDrive(ctx, active._id);
		return { jobId: active._id, generation: active.generation, isJoined: true };
	}

	const generation = (await latestGeneration(ctx.db)) + 1;
	const jobId = await ctx.db.insert('workspaceDeletionJobs', {
		generation,
		isActive: true,
		status: 'running',
		phase: resumeAt.phase,
		step: resumeAt.step,
		source: request.source,
		...(request.requestedBy !== undefined ? { requestedBy: request.requestedBy } : {}),
		joinedRequests: 0,
		rowsDeleted: 0,
		transactions: 0,
		verifyPasses: 0,
		attempts: 0,
		startedAt: now,
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

/**
 * One bounded transaction of job `jobId`: a sweep batch or a verification
 * pass, followed by the checkpoint. The caller runs it on the RAW mutation
 * context: this is the one writer the fence exempts.
 */
export async function runWorkspaceDeletionTransaction(
	ctx: MutationCtx,
	jobId: Id<'workspaceDeletionJobs'>
): Promise<DeletionTickOutcome> {
	const job = await ctx.db.get(jobId);
	// A failed job only moves again once it is re-armed (recovery or a new request).
	if (!job || !job.isActive || job.status === 'failed') return 'stopped';
	const now = Date.now();

	if (job.phase === 'verify') {
		const leftover = await firstNonEmptyTable(ctx.db);
		if (leftover === null) {
			await ctx.db.patch(jobId, {
				isActive: false,
				status: 'completed',
				verifyPasses: job.verifyPasses + 1,
				transactions: job.transactions + 1,
				attempts: 0,
				updatedAt: now,
				completedAt: now,
			});
			logInfo('[workspace deletion] completed', {
				generation: job.generation,
				rowsDeleted: job.rowsDeleted,
				verifyPasses: job.verifyPasses + 1,
			});
			return 'done';
		}
		const verifyPasses = job.verifyPasses + 1;
		if (verifyPasses >= MAX_VERIFY_PASSES) {
			await ctx.db.patch(jobId, {
				status: 'failed',
				verifyPasses,
				lastError: `Rows kept reappearing in ${leftover} after ${verifyPasses} verification passes`,
				lastErrorAt: now,
				lastErrorStep: leftover,
				updatedAt: now,
			});
			logWarn('[workspace deletion] verification keeps finding rows', {
				generation: job.generation,
				table: leftover,
				verifyPasses,
			});
			return 'stopped';
		}
		// Something wrote behind the sweep: sweep again from that table.
		await ctx.db.patch(jobId, {
			phase: 'sweep',
			step: leftover,
			verifyPasses,
			transactions: job.transactions + 1,
			attempts: 0,
			status: 'running',
			updatedAt: now,
		});
		return 'more';
	}

	const table = isDeletionTable(job.step) ? job.step : STEPS[0];
	const { deletedCount, hasMore } = await ORGANIZATION_DELETION_STEPS[table].deleteBatch(ctx);
	const next = hasMore ? table : nextTable(table);
	await ctx.db.patch(jobId, {
		phase: next === null ? 'verify' : 'sweep',
		step: next ?? table,
		rowsDeleted: job.rowsDeleted + deletedCount,
		transactions: job.transactions + 1,
		attempts: 0,
		status: 'running',
		updatedAt: now,
	});
	return 'more';
}

/** What an operator needs to see about a job. */
export function summarizeDeletionJob(job: WorkspaceDeletionJob): DeletionJobSummary {
	return {
		jobId: job._id,
		generation: job.generation,
		isActive: job.isActive,
		status: job.status,
		phase: job.phase,
		step: job.step,
		source: job.source,
		joinedRequests: job.joinedRequests,
		rowsDeleted: job.rowsDeleted,
		transactions: job.transactions,
		verifyPasses: job.verifyPasses,
		attempts: job.attempts,
		lastError: job.lastError ?? null,
		lastErrorAt: job.lastErrorAt ?? null,
		lastErrorStep: job.lastErrorStep ?? null,
		startedAt: job.startedAt,
		updatedAt: job.updatedAt,
		completedAt: job.completedAt ?? null,
	};
}

export interface DeletionJobSummary {
	jobId: Id<'workspaceDeletionJobs'>;
	generation: number;
	isActive: boolean;
	status: WorkspaceDeletionJob['status'];
	phase: WorkspaceDeletionJob['phase'];
	step: string;
	source: WorkspaceDeletionSource;
	joinedRequests: number;
	rowsDeleted: number;
	transactions: number;
	verifyPasses: number;
	attempts: number;
	lastError: string | null;
	lastErrorAt: number | null;
	lastErrorStep: string | null;
	startedAt: number;
	updatedAt: number;
	completedAt: number | null;
}

/** The active job, else the most recent one, else `null`. */
export async function readLatestDeletionJob(
	db: DatabaseReader
): Promise<WorkspaceDeletionJob | null> {
	return (
		(await readActiveWorkspaceDeletion(db)) ??
		(await db.query('workspaceDeletionJobs').withIndex('by_generation').order('desc').first())
	);
}
