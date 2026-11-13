/**
 * Count each Team Inbox thread's queued messages onto the thread
 * (migration 0074).
 *
 *   npx convex run migrations/0074_backfill_review_queue_counts:run
 *
 * The Answer badge sums `reviewDraftCount` and `reviewHeldCount` on the
 * threads (inbox/reviewQueueCount.ts). The status transition keeps them from
 * now on; this walk counts the messages already waiting. Until the walk has
 * completed, the badge reads the queue the old way, so a partly counted
 * deployment never shows a short number.
 *
 * TWO SWEEPS over `inboundMessages.by_processing_status`: `draft_ready`, then
 * `awaiting_clarification`. Each page recounts the threads its messages
 * belong to from the thread's own messages (`recountReviewQueue`), so a page
 * is idempotent, a thread met twice is recounted twice to the same value, and
 * a transition landing during the walk is never counted twice. Each page
 * records its cursor (`<status>:<paginate cursor>`) in the migration ledger
 * (`migrationRuns` row `0074_backfill_review_queue_counts`,
 * lib/migrationLedger.ts) before the next is scheduled. Running `run` again on
 * an unfinished walk resumes it; on a finished one it does nothing
 * (`'{"restart":true}'` starts over).
 *
 * A thread whose queued messages do not fit one recount fails the run instead
 * of being skipped: completing would switch the badge to counts that leave that
 * thread out. The page's cursor stays before that message, so a resume retries
 * it.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { logInfo, logWarn } from '../lib/runtimeLog';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationFailure,
	recordMigrationPage,
	scheduleMigrationPage,
} from '../lib/migrationLedger';
import { RECOUNT_ROW_BUDGET, RecountBudget } from '../maintenance/derivedFields/types';
import { recountReviewQueue, REVIEW_QUEUE_MIGRATION } from '../inbox/reviewQueueCount';

export const MIGRATION = REVIEW_QUEUE_MIGRATION;
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.22';
/**
 * One queued message per page, so a page recounts one thread: the recount
 * reads every queued message of it, bodies included, and several threads'
 * recounts in one transaction would pass Convex's 16 MiB read limit.
 */
export const PAGE_SIZE = 1;
/**
 * What that recount may read: the page's own message (one document) and the
 * batch Convex fetches past the allowance still fit under the read limit.
 */
export const RECOUNT_BYTES = 8 * 1024 * 1024;

const SWEEPS = ['draft_ready', 'awaiting_clarification'] as const;
type Sweep = (typeof SWEEPS)[number];

/** `null` is the start of the first sweep. */
function decodeCursor(cursor: string | null): { sweep: Sweep; cursor: string | null } {
	if (cursor === null) return { sweep: SWEEPS[0], cursor: null };
	const at = cursor.indexOf(':');
	const sweep = SWEEPS.find((s) => s === cursor.slice(0, at)) ?? SWEEPS[0];
	const rest = cursor.slice(at + 1);
	return { sweep, cursor: rest === '' ? null : rest };
}

/** The thread too large to recount, or how many threads changed. */
async function recountThreads(
	ctx: MutationCtx,
	messages: Doc<'inboundMessages'>[]
): Promise<{ changed: number; tooLarge?: Id<'conversationThreads'> }> {
	const threadIds = new Set<Id<'conversationThreads'>>();
	for (const message of messages) if (message.threadId) threadIds.add(message.threadId);
	let changed = 0;
	for (const threadId of threadIds) {
		const thread = await ctx.db.get(threadId);
		if (!thread) continue;
		const budget = new RecountBudget(RECOUNT_ROW_BUDGET, RECOUNT_BYTES);
		const counts = await recountReviewQueue(ctx, threadId, budget);
		if (!counts) return { changed, tooLarge: threadId };
		if (
			counts.reviewDraftCount === thread.reviewDraftCount &&
			counts.reviewHeldCount === thread.reviewHeldCount
		) {
			continue;
		}
		await ctx.db.patch(threadId, counts);
		changed++;
	}
	return { changed };
}

async function backfillPage(ctx: MutationCtx, stored: string | null) {
	const { sweep, cursor } = decodeCursor(stored);
	const page = await ctx.db
		.query('inboundMessages')
		.withIndex('by_processing_status', (q) => q.eq('processingStatus', sweep))
		.paginate({ numItems: PAGE_SIZE, cursor });
	const { changed, tooLarge } = await recountThreads(ctx, page.page);
	const next = SWEEPS[SWEEPS.indexOf(sweep) + 1];
	const isDone = page.isDone && next === undefined;
	const nextCursor = page.isDone && next ? `${next}:` : `${sweep}:${page.continueCursor}`;
	return { cursor: nextCursor, isDone, scanned: page.page.length, changed, tooLarge };
}

/** Run one page and schedule the next one of the same run. */
export const processPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), generation: v.number() },
	handler: async (ctx, args): Promise<{ isDone: boolean; isSuperseded?: boolean }> => {
		const run = await readMigrationRun(ctx, MIGRATION);
		if (!isCurrentMigrationPage(run, args.generation)) {
			logInfo('migration.0074_backfill_review_queue_counts.superseded', {
				generation: args.generation,
			});
			return { isDone: false, isSuperseded: true };
		}
		const result = await backfillPage(ctx, args.cursor);
		if (result.tooLarge) {
			const error = `Thread ${result.tooLarge}: its queued messages do not fit one recount`;
			await recordMigrationFailure(ctx, run, error);
			logWarn('migration.0074_backfill_review_queue_counts.failed', {
				threadId: result.tooLarge,
				generation: run.generation,
			});
			return { isDone: false };
		}
		await recordMigrationPage(ctx, run, {
			cursor: result.cursor,
			isDone: result.isDone,
			scanned: result.scanned,
			changed: result.changed,
		});
		logInfo('migration.0074_backfill_review_queue_counts.page', {
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
				internal.migrations['0074_backfill_review_queue_counts'].processPage,
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
			internal.migrations['0074_backfill_review_queue_counts'].processPage,
			{ cursor, generation: begun.generation }
		);
		logInfo('migration.0074_backfill_review_queue_counts.started', {
			cursor,
			generation: begun.generation,
		});
		return { started: true, generation: begun.generation };
	},
});
