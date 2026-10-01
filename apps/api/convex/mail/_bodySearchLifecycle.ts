/**
 * The fences around deep body search's background writes (ADR-0059): the
 * generation and lease helpers the per-mailbox index walk uses, and the
 * instance-wide sweep that clears every excerpt when the operator opts out.
 *
 * `mail/bodySearchBackfill.ts` owns the Convex functions; this module holds the
 * parts `workspaces/settings.update` also has to call inside ITS transaction,
 * so that turning the switch off retires in-flight indexing and starts the
 * sweep atomically with the setting itself.
 *
 * Not exported as Convex functions (the leading underscore keeps this module
 * off the public API surface).
 */

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { isBodySearchIndexingEnabled } from './searchBody';

/** Rows cleared per transaction by the purge. No blob reads, so it can be wider. */
const BODY_SEARCH_PURGE_BATCH = 256;

/** A row written before the fence existed is generation 0. */
export function generationOf(row: { generation?: number }): number {
	return row.generation ?? 0;
}

/**
 * Whether the scheduled function holding a lease can still run or finish on
 * its own. No lease recorded (a walk started before leases existed, or one
 * whose last page is committed), a missing job, or one that failed, was
 * cancelled or already returned all mean nothing will move the row again.
 */
export async function isLeaseLive(
	ctx: { db: QueryCtx['db'] },
	lease: Id<'_scheduled_functions'> | undefined
): Promise<boolean> {
	if (!lease) return false;
	const scheduled = await ctx.db.system.get(lease);
	return scheduled?.state.kind === 'pending' || scheduled?.state.kind === 'inProgress';
}

/** Every mailbox's backfill job row, for the sweep to retire or release. */
function readAllBackfillJobs(ctx: {
	db: QueryCtx['db'];
}): Promise<Doc<'mailBodySearchBackfillJobs'>[]> {
	return ctx.db.query('mailBodySearchBackfillJobs').collect(); // bounded: one row per mailbox on a single-org deployment, the same order as the fan-out search already reads
}

/** The sweep's progress row, or null when no opt-out has run since it existed. */
function readSearchBodyPurge(ctx: {
	db: QueryCtx['db'];
}): Promise<Doc<'mailBodySearchPurges'> | null> {
	return ctx.db.query('mailBodySearchPurges').first();
}

/**
 * Start the sweep that clears every stored excerpt. Called by
 * `workspaces/settings.update` whenever it writes the switch off, in that same
 * transaction, and by the residual-cleanup migration.
 *
 * It first retires every index walk: each job row turns into a running purge
 * under a new generation, so a batch still in flight commits nothing (its
 * commit would also find the switch off) and no mailbox keeps claiming a ready
 * body index. Then it starts a sweep from the first row under a new purge
 * generation, which supersedes any older sweep.
 *
 * `isTransition` is true when this write turned the switch from on to off. A
 * re-stated off joins a sweep that is still live instead, because nothing
 * could have written an excerpt since that sweep began; a finished, failed or
 * never-run sweep is started again, which is the idempotent cleanup for an
 * instance that is already off.
 */
export async function beginSearchBodyPurge(
	ctx: MutationCtx,
	{ isTransition }: { isTransition: boolean }
): Promise<{ generation: number; started: boolean }> {
	const purge = await readSearchBodyPurge(ctx);
	if (
		!isTransition &&
		purge?.status === 'running' &&
		(await isLeaseLive(ctx, purge.batchFunctionId))
	) {
		return { generation: purge.generation, started: false };
	}

	const now = Date.now();
	const jobs = await readAllBackfillJobs(ctx);
	for (const job of jobs) {
		await ctx.db.patch(job._id, {
			mode: 'purge' as const,
			status: 'running' as const,
			generation: generationOf(job) + 1,
			cursor: undefined,
			batchFunctionId: undefined,
			errorMessage: undefined,
			finishedAt: undefined,
			updatedAt: now,
		});
	}

	const generation = (purge?.generation ?? 0) + 1;
	const batchFunctionId = await ctx.scheduler.runAfter(
		0,
		internal.mail.bodySearchBackfill.purgeSearchBodies,
		{ cursor: null, generation }
	);
	const fresh = {
		status: 'running' as const,
		generation,
		cursor: undefined,
		scannedCount: 0,
		clearedCount: 0,
		startedAt: now,
		updatedAt: now,
		finishedAt: undefined,
		errorMessage: undefined,
		batchFunctionId,
	};
	if (purge) await ctx.db.patch(purge._id, fresh);
	else await ctx.db.insert('mailBodySearchPurges', fresh);
	return { generation, started: true };
}

/**
 * Stop the sweep because the operator turned the switch back ON: the rest of
 * their corpus should not be erased behind them. Called by
 * `workspaces/settings.update` on the off→on transition. The job rows the sweep
 * was retiring become `cancelled` purges, so `start` can run each mailbox's
 * index walk again (a purge row never counts as a ready index).
 */
export async function stopSearchBodyPurge(ctx: MutationCtx): Promise<void> {
	const now = Date.now();
	const purge = await readSearchBodyPurge(ctx);
	if (purge?.status === 'running') {
		await ctx.db.patch(purge._id, {
			status: 'cancelled',
			batchFunctionId: undefined,
			updatedAt: now,
			finishedAt: now,
		});
	}
	const jobs = await readAllBackfillJobs(ctx);
	for (const job of jobs) {
		if (job.mode !== 'purge' || job.status !== 'running') continue;
		await ctx.db.patch(job._id, { status: 'cancelled', updatedAt: now, finishedAt: now });
	}
}

/**
 * One page of the sweep, the body of `bodySearchBackfill.purgeSearchBodies`.
 * Clears the page and schedules the next in one transaction.
 *
 * Instance-wide and index-free on purpose: the switch is instance-wide, and
 * "which mailboxes happen to have excerpts" is exactly the question a full,
 * cursor-paginated walk answers without needing an index for it. A page runs
 * only for the current sweep's generation and at the sweep's stored cursor, so
 * a superseded sweep or a duplicate page does nothing.
 *
 * The last page also retires the job rows to completed purges, because leaving
 * a completed INDEX job behind would tell `resolveBodySearchMode` the body
 * index is ready for a mailbox whose excerpts have just been erased.
 */
export async function purgeSearchBodyPage(
	ctx: MutationCtx,
	args: { cursor: string | null; generation?: number }
): Promise<void> {
	const isEnabled = await isBodySearchIndexingEnabled(ctx);
	if (args.generation === undefined) {
		if (!isEnabled) await beginSearchBodyPurge(ctx, { isTransition: false });
		return;
	}
	const purge = await readSearchBodyPurge(ctx);
	if (!purge || purge.status !== 'running' || purge.generation !== args.generation) return;
	if (args.cursor !== (purge.cursor ?? null)) return;
	// Re-read the switch every page: an operator who flips it back ON
	// mid-sweep should not have the rest of their corpus erased behind them.
	if (isEnabled) {
		await stopSearchBodyPurge(ctx);
		return;
	}

	const now = Date.now();
	const { page, isDone, continueCursor } = await ctx.db
		.query('mailMessages')
		.paginate({ cursor: args.cursor, numItems: BODY_SEARCH_PURGE_BATCH });
	let cleared = 0;
	for (const message of page) {
		if (message.searchBody === undefined) continue;
		await ctx.db.patch(message._id, { searchBody: undefined });
		cleared += 1;
	}
	const progress = {
		scannedCount: purge.scannedCount + page.length,
		clearedCount: purge.clearedCount + cleared,
		updatedAt: now,
	};

	if (!isDone) {
		const batchFunctionId = await ctx.scheduler.runAfter(
			0,
			internal.mail.bodySearchBackfill.purgeSearchBodies,
			{ cursor: continueCursor, generation: args.generation }
		);
		await ctx.db.patch(purge._id, { ...progress, cursor: continueCursor, batchFunctionId });
		return;
	}

	await ctx.db.patch(purge._id, {
		...progress,
		status: 'completed',
		cursor: undefined,
		batchFunctionId: undefined,
		finishedAt: now,
	});
	// Last page: retire the job rows so no mailbox still claims a ready index.
	// Without this, disable → purge → re-enable would read the body index for a
	// mailbox whose excerpts have just been erased.
	const jobs = await readAllBackfillJobs(ctx);
	for (const job of jobs) {
		if (job.mode === 'purge' && job.status === 'completed') continue;
		await ctx.db.patch(job._id, {
			mode: 'purge' as const,
			status: 'completed' as const,
			cursor: undefined,
			batchFunctionId: undefined,
			updatedAt: now,
			finishedAt: now,
		});
	}
}
