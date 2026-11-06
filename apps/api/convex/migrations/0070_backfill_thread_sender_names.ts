/**
 * Give stored conversation rows their latest sender's display name
 * (migration 0070).
 *
 *   npx convex run migrations/0070_backfill_thread_sender_names:run
 *
 * Every write that moves a thread's newest message records `latestFromName`
 * beside `latestFromAddress`. Threads written before that carry only the
 * address, so their conversation row shows it until this walk copies the name
 * from the message `latestMessageId` points at. A row the walk has not reached
 * yet falls back to the address, so the walk is a cosmetic catch-up, never a
 * precondition.
 *
 * ONE SWEEP over `mailThreads`. A thread that already has a name, has no
 * `latestMessageId`, or whose newest message has no name is left untouched.
 * Each page records its cursor in the migration ledger (`migrationRuns` row
 * `0070_backfill_thread_sender_names`, lib/migrationLedger.ts) before the next
 * is scheduled. Running `run` again on an unfinished walk resumes it; on a
 * finished one it does nothing (`'{"restart":true}'` starts over). Pages are
 * idempotent: a name is only written where none is stored.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import { logInfo } from '../lib/runtimeLog';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
	scheduleMigrationPage,
} from '../lib/migrationLedger';

export const MIGRATION = '0070_backfill_thread_sender_names';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.21';
/**
 * Threads per page. Each thread reads one message as well, and both documents
 * can carry inline text (a thread its cached reply draft, a message its inline
 * body), so a page stays well inside a transaction's read limit.
 */
export const PAGE_SIZE = 50;

async function backfillPage(ctx: MutationCtx, cursor: string | null) {
	const { page, continueCursor, isDone } = await ctx.db
		.query('mailThreads')
		.paginate({ numItems: PAGE_SIZE, cursor });
	let changed = 0;
	for (const thread of page) {
		if (thread.latestFromName || !thread.latestMessageId) continue;
		const message = await ctx.db.get(thread.latestMessageId);
		if (!message?.fromName) continue;
		await ctx.db.patch(thread._id, { latestFromName: message.fromName });
		changed++;
	}
	return { cursor: continueCursor, isDone, scanned: page.length, changed };
}

/** Run one page and schedule the next one of the same run. */
export const processPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), generation: v.number() },
	handler: async (ctx, args): Promise<{ isDone: boolean; isSuperseded?: boolean }> => {
		const run = await readMigrationRun(ctx, MIGRATION);
		if (!isCurrentMigrationPage(run, args.generation)) {
			logInfo('migration.0070_backfill_thread_sender_names.superseded', {
				generation: args.generation,
			});
			return { isDone: false, isSuperseded: true };
		}
		const result = await backfillPage(ctx, args.cursor);
		await recordMigrationPage(ctx, run, {
			cursor: result.cursor,
			isDone: result.isDone,
			scanned: result.scanned,
			changed: result.changed,
		});
		logInfo('migration.0070_backfill_thread_sender_names.page', {
			scanned: result.scanned,
			changed: result.changed,
			isDone: result.isDone,
			generation: run.generation,
		});
		if (!result.isDone) {
			await scheduleMigrationPage(
				ctx,
				run,
				0,
				internal.migrations['0070_backfill_thread_sender_names'].processPage,
				{ cursor: result.cursor, generation: run.generation }
			);
		}
		return { isDone: result.isDone };
	},
});

/**
 * Start the background walk, or resume an unfinished one from its recorded
 * cursor (or from `cursor` when given). A finished migration is left alone
 * unless `restart` is set.
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
			internal.migrations['0070_backfill_thread_sender_names'].processPage,
			{ cursor, generation: begun.generation }
		);
		logInfo('migration.0070_backfill_thread_sender_names.started', {
			cursor,
			generation: begun.generation,
		});
		return { started: true, generation: begun.generation };
	},
});
