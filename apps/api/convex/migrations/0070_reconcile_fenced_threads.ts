/**
 * Reconcile the threads fenced before the per-row reconciliation existed
 * (migration 0070).
 *
 *   npx convex run migrations/0070_reconcile_fenced_threads:run
 *
 * A re-verified signature that narrows an interpreted message fences its
 * thread (`mailThreads.interpretationStaleSince`, mail/interpret/staleFence.ts).
 * From this release on the same write starts the thread's withdraw job
 * (mail/interpret/scopeReconcile.ts), which withdraws the old read row by row
 * and lifts the fence when it is done. A thread fenced by an earlier release
 * has no job, so its fence would only ever lift by hand.
 *
 * The fence does not say which message narrowed, so each fenced thread gets
 * a withdraw job that pages through every one of its messages first
 * (`startFencedThreadScan`): a read that no longer holds is one whose body
 * fingerprint (`messageInterpretations.sourceVersion`,
 * mail/interpret/sourceVersion.ts) is not the stored message's any more,
 * which a clearsigned scope gained later changes. The job's cursor carries
 * that scan across transactions, and the fence lifts only in a range after
 * its last page, so a long thread is never released on a partial scan. A
 * thread where none is found stays fenced for the operator
 * (`staleFence:release`).
 *
 * ONE WALK over the `by_interpretation_stale` index, {@link PAGE_SIZE}
 * threads a page, each page's cursor recorded in the migration ledger
 * (`migrationRuns` row `0070_reconcile_fenced_threads`) before the next is
 * scheduled. Pages are idempotent: a thread whose job already runs starts its
 * walk over with the scan added, which withdraws the same reads. `run`
 * resumes an unfinished walk and leaves a finished one alone
 * (`'{"restart":true}'` walks again).
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { logInfo } from '../lib/runtimeLog';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
	scheduleMigrationPage,
} from '../lib/migrationLedger';
import { startFencedThreadScan } from '../mail/interpret/scopeReconcile';

export const MIGRATION = '0070_reconcile_fenced_threads';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.20';
/** Fenced threads a page handles. */
export const PAGE_SIZE = 10;

/** Run one page and schedule the next one of the same run. */
export const processPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), generation: v.number() },
	handler: async (ctx, args): Promise<{ isDone: boolean; isSuperseded?: boolean }> => {
		const run = await readMigrationRun(ctx, MIGRATION);
		if (!isCurrentMigrationPage(run, args.generation)) {
			logInfo('migration.0070_reconcile_fenced_threads.superseded', {
				generation: args.generation,
			});
			return { isDone: false, isSuperseded: true };
		}
		const page = await ctx.db
			.query('mailThreads')
			.withIndex('by_interpretation_stale', (q) => q.gte('interpretationStaleSince', 0))
			.paginate({ numItems: PAGE_SIZE, cursor: args.cursor });
		for (const thread of page.page) await startFencedThreadScan(ctx, thread._id);
		await recordMigrationPage(ctx, run, {
			cursor: page.continueCursor,
			isDone: page.isDone,
			scanned: page.page.length,
			changed: page.page.length,
		});
		logInfo('migration.0070_reconcile_fenced_threads.page', {
			scanned: page.page.length,
			isDone: page.isDone,
			generation: run.generation,
		});
		if (!page.isDone) {
			await scheduleMigrationPage(
				ctx,
				run,
				0,
				internal.migrations['0070_reconcile_fenced_threads'].processPage,
				{ cursor: page.continueCursor, generation: run.generation }
			);
		}
		return { isDone: page.isDone };
	},
});

/**
 * Start the walk, or resume an unfinished one from its recorded cursor (or
 * from `cursor` when given). A finished migration is left alone unless
 * `restart` is set.
 */
export const run = internalMutation({
	args: {
		cursor: v.optional(v.union(v.string(), v.null())),
		restart: v.optional(v.boolean()),
	},
	handler: async (
		ctx,
		args
	): Promise<{ started: boolean; generation?: number; reason?: string }> => {
		const begun = await beginMigrationRun(ctx, {
			migration: MIGRATION,
			introducedIn: INTRODUCED_IN,
			cursor: args.cursor,
			restart: args.restart,
		});
		if (!begun) {
			return { started: false, reason: 'Already completed; pass restart to run it again' };
		}
		const cursor = begun.cursor ?? null;
		await scheduleMigrationPage(
			ctx,
			begun,
			0,
			internal.migrations['0070_reconcile_fenced_threads'].processPage,
			{ cursor, generation: begun.generation }
		);
		logInfo('migration.0070_reconcile_fenced_threads.started', {
			cursor,
			generation: begun.generation,
		});
		return { started: true, generation: begun.generation };
	},
});
