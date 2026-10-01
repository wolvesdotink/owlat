/**
 * Backfill the IMAP folder membership (#927, migration 0054).
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
import { logInfo } from '../lib/runtimeLog';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
	type MigrationRun,
} from '../lib/migrationLedger';
import { resetFolderMembership, startFolderMembership } from '../mail/folderMembership';

const MIGRATION = '0054_backfill_folder_membership';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.7';

/** Folders per page: each costs a state-row read and write and one scheduled step. */
const PAGE_SIZE = 100;

/** How often `finish` checks whether every walk is ready. */
const FINISH_POLL_MS = 60_000;

/** A walk whose state row has not changed for this long has lost its chain. */
const STALLED_MS = 10 * 60_000;

/** The ledger `mode` of a rebuild pass. */
const REBUILD = 'rebuild';

async function currentRun(ctx: MutationCtx, generation: number): Promise<MigrationRun | null> {
	const run = await readMigrationRun(ctx, MIGRATION);
	return isCurrentMigrationPage(run, generation) ? run : null;
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
			await ctx.scheduler.runAfter(0, internal.maintenance.folderMembershipBackfill.step, {
				folderId: folder._id,
			});
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
		await ctx.scheduler.runAfter(0, next, {
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
		const stalest = await ctx.db
			.query('mailFolderMembership')
			.withIndex('by_is_ready_and_updated', (q) => q.eq('isReady', false))
			.first();
		if (!stalest) {
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
		if (stalest.updatedAt < Date.now() - STALLED_MS) {
			await ctx.db.patch(stalest._id, { updatedAt: Date.now() });
			await ctx.scheduler.runAfter(0, internal.maintenance.folderMembershipBackfill.step, {
				folderId: stalest.folderId,
			});
		}
		await ctx.scheduler.runAfter(
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
	handler: async (
		ctx,
		args
	): Promise<{ started: boolean; generation?: number; reason?: string }> => {
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
		const begun = await beginMigrationRun(ctx, {
			migration: MIGRATION,
			introducedIn: INTRODUCED_IN,
			restart: args.restart === true || rebuild,
			...(rebuild ? { mode: REBUILD } : {}),
		});
		if (!begun) {
			return { started: false, reason: 'Already completed; pass restart to run it again' };
		}
		await ctx.scheduler.runAfter(
			0,
			internal.migrations['0054_backfill_folder_membership'].startPage,
			{ cursor: begun.cursor ?? null, generation: begun.generation }
		);
		logInfo('migration.0054_backfill_folder_membership.started', {
			generation: begun.generation,
			isRebuild: begun.mode === REBUILD,
		});
		return { started: true, generation: begun.generation };
	},
});

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
