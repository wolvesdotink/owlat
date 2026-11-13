/**
 * Backfill the label membership rows (migration 0073).
 *
 *   npx convex run migrations/0073_backfill_label_membership:run
 *
 * Every write that inserts a labeled message, changes `labelIds` or deletes a
 * message keeps `mailLabelMessages` in step (`mail/labelMessageIndex.ts`), and
 * a mailbox provisioned since starts out ready. A mailbox that held mail
 * before has rows only for what was written since, so its label view and
 * thread label reconciliation keep scanning messages until this walk has
 * added every message's pairs and marked the mailbox ready. Nothing waits on
 * it beyond that.
 *
 * ONE MAILBOX AT A TIME. Each page takes the first mailbox created after the
 * ledger cursor and walks up to {@link MESSAGES_PER_PAGE} of its messages from
 * the cursor on the mailbox's `mailLabelMembership` row. The ledger cursor
 * advances only once that mailbox is ready, and both cursors are written in
 * the page's own transaction, so an interrupted pass resumes where it stopped.
 * The page that finds no mailbox left completes the pass.
 * Pages are idempotent: a pair is only inserted where none is stored, and a
 * ready mailbox costs one read. Running `run` again on an unfinished pass
 * resumes it; on a finished one it does nothing (`'{"restart":true}'` passes
 * over every mailbox again, skipping ready ones).
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
import { backfillLabelMembershipStep } from '../mail/labelMessageIndex';

export const MIGRATION = '0073_backfill_label_membership';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.22';
/**
 * Messages per page. Each is read whole and costs one indexed read per label
 * it carries, so a page stays well inside a transaction's read limit.
 */
export const MESSAGES_PER_PAGE = 100;

/**
 * The mailbox cursor is the creation time of the last mailbox whose walk is
 * done ('' before the first). A page may run only one `paginate`, which the
 * message walk takes, so the mailboxes are walked by creation time instead.
 */
function lastDoneMailbox(cursor: string | null | undefined): number | null {
	return cursor ? Number(cursor) : null;
}
/** Walk one page of the current mailbox and schedule the next page of the same run. */
export const processPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), generation: v.number() },
	handler: async (ctx, args): Promise<{ isDone: boolean; isSuperseded?: boolean }> => {
		const run = await readMigrationRun(ctx, MIGRATION);
		if (!isCurrentMigrationPage(run, args.generation)) {
			logInfo('migration.0073_backfill_label_membership.superseded', {
				generation: args.generation,
			});
			return { isDone: false, isSuperseded: true };
		}
		const after = lastDoneMailbox(args.cursor);
		const mailbox = await ctx.db
			.query('mailboxes')
			.withIndex('by_creation_time', (q) => (after === null ? q : q.gt('_creationTime', after)))
			.first();
		const step = mailbox
			? await backfillLabelMembershipStep(ctx, mailbox._id, MESSAGES_PER_PAGE)
			: { isReady: true, scanned: 0, changed: 0 };
		// Stay on this mailbox until its walk is done.
		const next = mailbox && step.isReady ? String(mailbox._creationTime) : args.cursor;
		const isFinished = !mailbox;
		await recordMigrationPage(ctx, run, {
			cursor: next ?? '',
			isDone: isFinished,
			scanned: step.scanned,
			changed: step.changed,
		});
		logInfo('migration.0073_backfill_label_membership.page', {
			scanned: step.scanned,
			changed: step.changed,
			isMailboxReady: step.isReady,
			isDone: isFinished,
			generation: run.generation,
		});
		if (!isFinished) {
			await scheduleMigrationPage(
				ctx,
				run,
				0,
				internal.migrations['0073_backfill_label_membership'].processPage,
				{ cursor: next, generation: run.generation }
			);
		}
		return { isDone: isFinished };
	},
});

/**
 * Start the background walk, or resume an unfinished one from its recorded
 * cursor. A finished migration is left alone unless `restart` is set.
 */
export const run = internalMutation({
	args: { restart: v.optional(v.boolean()) },
	handler: async (
		ctx,
		args
	): Promise<{ started: boolean; generation?: number; reason?: string }> => {
		const begun = await beginMigrationRun(ctx, {
			migration: MIGRATION,
			introducedIn: INTRODUCED_IN,
			restart: args.restart,
		});
		if (!begun) {
			return { started: false, reason: 'Already completed; pass restart to run it again' };
		}
		const cursor = begun.cursor || null;
		await scheduleMigrationPage(
			ctx,
			begun,
			0,
			internal.migrations['0073_backfill_label_membership'].processPage,
			{ cursor, generation: begun.generation }
		);
		logInfo('migration.0073_backfill_label_membership.started', {
			generation: begun.generation,
		});
		return { started: true, generation: begun.generation };
	},
});
