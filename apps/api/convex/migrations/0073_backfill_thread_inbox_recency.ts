/**
 * Give stored threads their Inbox recency (migration 0073).
 *
 *   npx convex run migrations/0073_backfill_thread_inbox_recency:run
 *
 * Every write of a thread's `folderRoles` or `lastMessageAt` sets
 * `inboxLastMessageAt` beside them (mail/threadInboxRecency.ts). Threads
 * written before that carry none, so the conversation list keeps scanning the
 * mailbox by recency until this walk has set it on every thread and its ledger
 * row reads `completed`; from then on the Inbox reads its own index.
 *
 * ONE SWEEP over `mailThreads`. A thread whose value is already right is left
 * untouched. Each page records its cursor in the migration ledger
 * (`migrationRuns` row `0073_backfill_thread_inbox_recency`,
 * lib/migrationLedger.ts) before the next is scheduled. Running `run` again on
 * an unfinished walk resumes it; on a finished one it does nothing
 * (`'{"restart":true}'` starts over, and the list scans again until it ends).
 * Pages are idempotent: the value is derived from the row it is written to.
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
import { INBOX_RECENCY_MIGRATION, inboxLastMessageAt } from '../mail/threadInboxRecency';

export const MIGRATION = INBOX_RECENCY_MIGRATION;
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.22';
/**
 * Threads per page. A page reads only the threads themselves, but a thread can
 * carry inline text (its cached reply draft), so a page stays well inside a
 * transaction's read limit.
 */
export const PAGE_SIZE = 100;

async function backfillPage(ctx: MutationCtx, cursor: string | null) {
	const { page, continueCursor, isDone } = await ctx.db
		.query('mailThreads')
		.paginate({ numItems: PAGE_SIZE, cursor });
	let changed = 0;
	for (const thread of page) {
		const expected = inboxLastMessageAt(thread);
		if (thread.inboxLastMessageAt === expected) continue;
		await ctx.db.patch(thread._id, { inboxLastMessageAt: expected });
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
			logInfo('migration.0073_backfill_thread_inbox_recency.superseded', {
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
		logInfo('migration.0073_backfill_thread_inbox_recency.page', {
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
				internal.migrations['0073_backfill_thread_inbox_recency'].processPage,
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
			internal.migrations['0073_backfill_thread_inbox_recency'].processPage,
			{ cursor, generation: begun.generation }
		);
		logInfo('migration.0073_backfill_thread_inbox_recency.started', {
			cursor,
			generation: begun.generation,
		});
		return { started: true, generation: begun.generation };
	},
});
