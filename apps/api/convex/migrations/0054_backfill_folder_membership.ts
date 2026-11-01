/**
 * Backfill the IMAP folder membership (migration 0054).
 *
 * Starts the membership walk for every folder that existed before folder
 * membership was maintained. Each folder walks in the background as its own
 * chain of bounded mutations (`maintenance/folderMembershipBackfill.ts`), with
 * its cursor and watermark on its `mailFolderMembership` row; until a folder
 * is ready the IMAP server keeps listing its UIDs from `mailMessages`, exactly
 * as the previous release did, so nothing waits on this.
 *
 *   npx convex run migrations/0054_backfill_folder_membership:run
 *   npx convex run migrations/0054_backfill_folder_membership:status
 *
 * RUNS BY ITSELF: a cron calls {@link ensure} every 10 minutes (crons.ts,
 * "ensure folder membership backfill"). It starts the pass on a
 * deployment that never ran it and resumes one whose ledger row has not moved
 * for {@link RESUME_AFTER_MS}, so every deployment reaches `completed` without
 * an operator step, and a pass whose chain died is picked up again. Until then
 * the IMAP server lists every unready folder in full documents on each
 * command; leaving that to a hand-run step left it in place indefinitely
 * wherever nobody ran it. Running `run` by hand still works and only
 * starts it sooner.
 *
 * DURABLE AND RESUMABLE: progress and completion live in the migration ledger
 * (`migrationRuns` row `0054_backfill_folder_membership`, lib/migrationLedger.ts).
 * `run` schedules the first page of the folder pass; each page starts the
 * walks of up to {@link PAGE_SIZE} folders and records its cursor and counts in
 * the same transaction. After the last page, `finish` waits for every walk to
 * be ready and then marks the ledger row `completed`, so `completed` means
 * every folder's membership is exact. While it waits it restarts any walk that
 * has not moved for {@link STALLED_MS} (its chain died: a failed step, a
 * redeploy mid-chain); a walk resumes from its stored cursor.
 *
 * FAILING WALKS: every walk step is scheduled with its job recorded on the
 * folder's state row (`walkJob`, with the retry epoch below), so `finish` can
 * tell a failed step from a slow one. Each poll checks every stalled walk (up
 * to {@link STALLED_BATCH}) and extends a folder's failure streak by each step
 * that failed, counting a step once. Once one folder's step has failed
 * {@link MAX_WALK_FAILURES} times in a row, `finish` records the error on the
 * ledger row and stops polling: the migration reads as failed (Settings →
 * System & updates), and {@link ensure} no longer resumes it.
 *
 * Streaks belong to the ledger row's `retryEpoch`, which only `run` (an
 * operator's start or retry) bumps. The cron's hourly resume bumps the
 * generation but not the epoch, so it never wipes a streak; only committed
 * progress on that folder or an operator's run does, and a step scheduled
 * before that run never counts toward the new streak.
 *
 * Running `run` again on an unfinished pass resumes it and supersedes any
 * chain still queued; on a finished one it does nothing. `'{"restart": true}'`
 * passes over every folder again (a ready folder is left alone, a walking one
 * gets another step). `'{"rebuild": true}'` walks every folder again from
 * scratch, the repair for a membership found out of step: each folder stops
 * being ready, its old blocks are cleared, and its revision moves so no IMAP
 * server keeps a map it cached from them.
 *
 * A rebuild is recorded as the ledger row's `mode`, and every page reads it
 * from there. A plain `run` that resumes an interrupted rebuild therefore goes
 * on rebuilding; it cannot turn the remaining pages into an ordinary pass that
 * skips ready folders and then marks the repair completed. `restart` is refused
 * while a rebuild is unfinished, for the same reason: pass `rebuild` to start
 * the repair over.
 */

import { v } from 'convex/values';
import { internalQuery, type MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { logInfo, logWarn } from '../lib/runtimeLog';
import type { Doc } from '../_generated/dataModel';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationFailure,
	recordMigrationPage,
	scheduleMigrationPage,
	type MigrationRun,
} from '../lib/migrationLedger';
import {
	resetFolderMembership,
	scheduleFolderWalkStep,
	startFolderMembership,
} from '../mail/folderMembership';

const MIGRATION = '0054_backfill_folder_membership';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.7';

/** Folders per page: each costs a state-row read and write and one scheduled step. */
const PAGE_SIZE = 100;

/** How often `finish` checks whether every walk is ready. */
const FINISH_POLL_MS = 60_000;

/** A walk whose state row has not changed for this long has lost its chain. */
const STALLED_MS = 10 * 60_000;

/** Failed steps in a row after which a folder's walk fails the migration. */
const MAX_WALK_FAILURES = 3;

/** Stalled walks `finish` reads and restarts per poll. */
const STALLED_BATCH = 25;

/** The ledger `mode` of a rebuild pass. */
const REBUILD = 'rebuild';

/**
 * A running pass whose ledger row has not moved for this long is resumed by
 * {@link ensure}. The folder pass writes the row on every page, and `finish`
 * does not write it while it polls, so a pass waiting on its walks is resumed
 * (cheaply: the folder pass is already at its end) at most once per period.
 */
const RESUME_AFTER_MS = 60 * 60_000;

async function currentRun(ctx: MutationCtx, generation: number): Promise<MigrationRun | null> {
	const run = await readMigrationRun(ctx, MIGRATION);
	return isCurrentMigrationPage(run, generation) ? run : null;
}

/**
 * The walk's failure streak once its recorded step is read: one longer when
 * that step failed, null when it did not, or when it does not count. A step
 * counts once (`lastJobId`), and only in the retry `epoch` it was scheduled
 * under: one from before the operator's last retry never starts a new streak.
 * A failed mutation rolls back its own writes, so the streak lives here, kept
 * by the poll that finds the failure.
 */
async function countWalkFailure(
	ctx: MutationCtx,
	walk: Doc<'mailFolderMembership'>,
	epoch: number
): Promise<NonNullable<Doc<'mailFolderMembership'>['walkFailures']> | null> {
	const recorded = walk.walkJob;
	if (!recorded || recorded.epoch !== epoch) return null;
	if (walk.walkFailures?.lastJobId === recorded.id) return null;
	const job = await ctx.db.system.get(recorded.id);
	if (job?.state.kind !== 'failed') return null;
	const prior = walk.walkFailures?.epoch === epoch ? walk.walkFailures.count : 0;
	return {
		epoch,
		count: prior + 1,
		lastError: job.state.error || 'The folder walk step failed without an error message',
		lastJobId: recorded.id,
	};
}

/** Start (or, in a rebuild, reset) the walks of one page of folders. */
export const startPage = internalMutation({
	args: {
		cursor: v.union(v.string(), v.null()),
		generation: v.number(),
	},
	handler: async (ctx, args) => {
		const run = await currentRun(ctx, args.generation);
		if (!run) return { isSuperseded: true };
		const rebuild = run.mode === REBUILD;
		const { page, continueCursor, isDone } = await ctx.db
			.query('mailFolders')
			.paginate({ numItems: PAGE_SIZE, cursor: args.cursor });
		let walking = 0;
		for (const folder of page) {
			if (rebuild) {
				await resetFolderMembership(ctx, folder._id);
			} else if ((await startFolderMembership(ctx, folder._id)) === 'ready') {
				continue;
			}
			walking += 1;
			await scheduleFolderWalkStep(ctx, folder._id, { epoch: run.retryEpoch ?? 0 });
		}
		// The ledger completes in `finish`, once the walks started here are ready.
		await recordMigrationPage(ctx, run, {
			cursor: continueCursor,
			isDone: false,
			scanned: page.length,
			changed: walking,
		});
		const next = isDone
			? internal.migrations['0054_backfill_folder_membership'].finish
			: internal.migrations['0054_backfill_folder_membership'].startPage;
		await scheduleMigrationPage(ctx, run, 0, next, {
			cursor: continueCursor,
			generation: run.generation,
		});
		logInfo('migration.0054_backfill_folder_membership.page', {
			scanned: page.length,
			walking,
			isDone,
			generation: run.generation,
		});
		return { isSuperseded: false };
	},
});

/**
 * Mark the ledger row completed once no folder is walking; until then check
 * again every {@link FINISH_POLL_MS}, restarting the stalest walk if it has
 * stalled. `cursor` is accepted so `startPage` can hand its own arguments on;
 * it is not used.
 */
export const finish = internalMutation({
	args: {
		cursor: v.union(v.string(), v.null()),
		generation: v.number(),
	},
	handler: async (ctx, args) => {
		const run = await currentRun(ctx, args.generation);
		if (!run) return { isSuperseded: true, isCompleted: false };
		const walking = await ctx.db
			.query('mailFolderMembership')
			.withIndex('by_is_ready_and_updated', (q) => q.eq('isReady', false))
			.first();
		if (!walking) {
			await recordMigrationPage(ctx, run, {
				cursor: run.cursor ?? '',
				isDone: true,
				scanned: 0,
				changed: 0,
			});
			logInfo('migration.0054_backfill_folder_membership.completed', {
				generation: run.generation,
			});
			return { isSuperseded: false, isCompleted: true };
		}
		// Every stalled walk, stalest first and a bounded batch per poll, so how
		// fast a failing folder is found does not grow with the number of folders.
		const now = Date.now();
		const stalled = await ctx.db
			.query('mailFolderMembership')
			.withIndex('by_is_ready_and_updated', (q) =>
				q.eq('isReady', false).lt('updatedAt', now - STALLED_MS)
			)
			.take(STALLED_BATCH);
		const epoch = run.retryEpoch ?? 0;
		for (const walk of stalled) {
			const walkFailures = await countWalkFailure(ctx, walk, epoch);
			if (walkFailures && walkFailures.count >= MAX_WALK_FAILURES) {
				// Retrying has not helped: stop polling and fail the migration, so the
				// card and its runner show the error instead of waiting forever.
				const error = `Folder ${walk.folderId}: ${walkFailures.lastError}`;
				await ctx.db.patch(walk._id, { walkFailures });
				await recordMigrationFailure(ctx, run, error);
				logWarn('migration.0054_backfill_folder_membership.walk_failed', {
					folderId: walk.folderId,
					failures: walkFailures.count,
					generation: run.generation,
				});
				return { isSuperseded: false, isCompleted: false, isFailed: true };
			}
			await ctx.db.patch(walk._id, { updatedAt: now, ...(walkFailures ? { walkFailures } : {}) });
			await scheduleFolderWalkStep(ctx, walk.folderId, { epoch });
		}
		await scheduleMigrationPage(
			ctx,
			run,
			FINISH_POLL_MS,
			internal.migrations['0054_backfill_folder_membership'].finish,
			{ cursor: null, generation: run.generation }
		);
		return { isSuperseded: false, isCompleted: false };
	},
});

/**
 * Start the folder pass, or resume an unfinished one, in its recorded mode,
 * from its recorded cursor. A finished migration is left alone unless `restart`
 * or `rebuild` is set; an unfinished rebuild is not replaced by a `restart`.
 */
export const run = internalMutation({
	args: { restart: v.optional(v.boolean()), rebuild: v.optional(v.boolean()) },
	handler: async (ctx, args): Promise<BeginResult> => {
		const rebuild = args.rebuild === true;
		if (args.restart === true && !rebuild) {
			const existing = await readMigrationRun(ctx, MIGRATION);
			if (existing?.status === 'running' && existing.mode === REBUILD) {
				return {
					started: false,
					reason:
						'A rebuild is unfinished; run without arguments to resume it, or pass rebuild to start it over',
				};
			}
		}
		return await begin(ctx, {
			restart: args.restart === true || rebuild,
			rebuild,
			isOperatorRetry: true,
		});
	},
});

/**
 * The cron's entry (see the header): start the pass if it never ran, resume it
 * if its ledger row has been still for {@link RESUME_AFTER_MS}, and otherwise
 * do nothing. A resume keeps the recorded mode, so an interrupted rebuild goes
 * on rebuilding. Never restarts a completed pass and never starts a rebuild of
 * its own. Once the pass has completed, a call costs one indexed read.
 */
export const ensure = internalMutation({
	args: {},
	handler: async (ctx): Promise<BeginResult> => {
		const existing = await readMigrationRun(ctx, MIGRATION);
		if (existing?.status === 'completed') return { started: false };
		// A pass that failed on a folder waits for someone to look: resuming it
		// here would only fail the same folder again.
		if (existing?.failure) return { started: false };
		if (existing && existing.updatedAt > Date.now() - RESUME_AFTER_MS) return { started: false };
		return await begin(ctx, { restart: false, rebuild: false, isOperatorRetry: false });
	},
});

interface BeginResult {
	started: boolean;
	generation?: number;
	reason?: string;
}

async function begin(
	ctx: MutationCtx,
	options: { restart: boolean; rebuild: boolean; isOperatorRetry: boolean }
): Promise<BeginResult> {
	const begun = await beginMigrationRun(ctx, {
		migration: MIGRATION,
		introducedIn: INTRODUCED_IN,
		restart: options.restart,
		...(options.rebuild ? { mode: REBUILD } : {}),
	});
	if (!begun) {
		return { started: false, reason: 'Already completed; pass restart to run it again' };
	}
	// Only a person's run starts the folder walks' failure streaks over; the
	// cron's resume keeps them, so a folder that keeps failing still fails it.
	if (options.isOperatorRetry) {
		await ctx.db.patch(begun._id, { retryEpoch: (begun.retryEpoch ?? 0) + 1 });
	}
	await scheduleMigrationPage(
		ctx,
		begun,
		0,
		internal.migrations['0054_backfill_folder_membership'].startPage,
		{
			cursor: begun.cursor ?? null,
			generation: begun.generation,
		}
	);
	logInfo('migration.0054_backfill_folder_membership.started', {
		generation: begun.generation,
		isRebuild: begun.mode === REBUILD,
	});
	return { started: true, generation: begun.generation };
}

/** The ledger row, and how many folders are ready and still walking (first 5,000). */
export const status = internalQuery({
	args: {},
	handler: async (ctx) => {
		const run = await readMigrationRun(ctx, MIGRATION);
		const rows = await ctx.db.query('mailFolderMembership').take(5000);
		const walking = rows.filter((row) => !row.isReady);
		return {
			status: run?.status ?? 'not started',
			isRebuild: run?.mode === REBUILD,
			completedAt: run?.completedAt ?? null,
			foldersStarted: run?.changedCount ?? 0,
			ready: rows.length - walking.length,
			walking: walking.length,
			walkingFolders: walking.slice(0, 20).map((row) => row.folderId),
		};
	},
});
