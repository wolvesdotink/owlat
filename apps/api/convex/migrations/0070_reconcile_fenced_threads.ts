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
 * The fence does not say which message narrowed. A read that no longer holds
 * is one whose body fingerprint (`messageInterpretations.sourceVersion`,
 * mail/interpret/sourceVersion.ts) is not the stored message's any more,
 * which a clearsigned scope gained later changes: each message of a fenced
 * thread with such a current read gets its read withdrawn, through the same
 * entry point the re-verification uses. A fenced thread where none is found
 * stays fenced for the operator (`staleFence:release`).
 *
 * ONE WALK over the `by_interpretation_stale` index, {@link PAGE_SIZE}
 * threads a page, each page's cursor recorded in the migration ledger
 * (`migrationRuns` row `0070_reconcile_fenced_threads`) before the next is
 * scheduled. A thread's messages are read up to {@link MESSAGE_SCAN}; a
 * thread with more is reconciled for the narrowed messages among those, and
 * the log says so. Pages are idempotent: a thread whose job already runs has
 * the same reads added to it, which changes nothing. `run` resumes an
 * unfinished walk and leaves a finished one alone (`'{"restart":true}'`
 * walks again).
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { logInfo } from '../lib/runtimeLog';
import { interpretationSourceKey } from '../lib/validators/threadBrief';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
	scheduleMigrationPage,
} from '../lib/migrationLedger';
import { sourceVersionOf } from '../mail/interpret/sourceVersion';
import { startScopeReconcile } from '../mail/interpret/scopeReconcile';

export const MIGRATION = '0070_reconcile_fenced_threads';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.20';
/** Fenced threads a page handles. */
export const PAGE_SIZE = 10;
/** Messages of one fenced thread read for narrowed reads. */
export const MESSAGE_SCAN = 300;

/** Does a current read of the message predate what is stored now (its fingerprint moved)? */
async function isReadStale(ctx: MutationCtx, message: Doc<'mailMessages'>): Promise<boolean> {
	for (const kind of ['mail', 'outboundMail'] as const) {
		const source = { kind, id: message._id };
		const read = await ctx.db
			.query('messageInterpretations')
			.withIndex('by_source_current', (q) =>
				q.eq('sourceKey', interpretationSourceKey(source)).eq('isCurrent', true)
			)
			.first();
		if (!read?.payload) continue;
		if (read.sourceVersion !== (await sourceVersionOf(ctx, source))) return true;
	}
	return false;
}

/** Start the reconciliation of one fenced thread; how many narrowed messages it found. */
export async function reconcileFencedThread(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<{ narrowed: number; isCut: boolean }> {
	const messages = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.take(MESSAGE_SCAN + 1);
	let narrowed = 0;
	for (const message of messages.slice(0, MESSAGE_SCAN)) {
		if (!message.inboundSignatureInfo?.scope) continue;
		if (!(await isReadStale(ctx, message))) continue;
		await startScopeReconcile(ctx, threadId, message._id);
		narrowed++;
	}
	return { narrowed, isCut: messages.length > MESSAGE_SCAN };
}

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
		let changed = 0;
		let unresolved = 0;
		let cut = 0;
		for (const thread of page.page) {
			const found = await reconcileFencedThread(ctx, thread._id);
			if (found.narrowed > 0) changed++;
			else unresolved++;
			if (found.isCut) cut++;
		}
		await recordMigrationPage(ctx, run, {
			cursor: page.continueCursor,
			isDone: page.isDone,
			scanned: page.page.length,
			changed,
		});
		logInfo('migration.0070_reconcile_fenced_threads.page', {
			scanned: page.page.length,
			changed,
			unresolved,
			cut,
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
