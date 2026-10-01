/**
 * Give connected mailboxes the mail-sync worker parked on one refused login
 * another try (migration 0056).
 *
 * ImapFlow reports every NO to LOGIN as an authentication failure, and the
 * worker used to mark the account `auth_error` on the first one — including the
 * refusals a provider sends for passing reasons (Gmail's `[UNAVAILABLE]`, "Too
 * many simultaneous connections", an app password briefly answered with
 * "Invalid credentials"). `auth_error` is not connectable, so such a mailbox —
 * a shared team inbox included — stopped receiving mail until someone
 * re-entered a password that had never changed. The worker now only parks an
 * account once its login has been refused for 15 minutes straight
 * (apps/mail-sync/src/loginFailure.ts).
 *
 *   npx convex run migrations/0056_retry_parked_mail_accounts:run
 *
 * Run it once the worker carrying that change is deployed: every `auth_error`
 * mailbox goes back to `pending` and the worker is woken to connect it. One
 * whose credentials really are wrong is parked again after the grace period;
 * one whose Google authorization was revoked is parked again on its first
 * credential fetch, with the "Reconnect with Google" message restored. Seed
 * mailboxes are left alone: the inbound worker never connects them.
 *
 * DURABLE AND RESUMABLE: `run` schedules the first page; each page is its own
 * mutation over the `by_status` index that schedules the next one. Progress
 * and completion live in the migration ledger (`migrationRuns` row
 * `0056_retry_parked_mail_accounts`, lib/migrationLedger.ts): each page
 * records its cursor and counts in the same transaction as its writes, and the
 * final page marks the row `completed`. Running `run` again on an unfinished
 * pass resumes it and supersedes any chain still queued; on a finished one it
 * does nothing, so a mailbox the worker has since parked for good stays parked
 * (`'{"restart":true}'` retries every parked mailbox again). Pages are
 * idempotent: a retried row has left the index range the walk reads.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { logInfo } from '../lib/runtimeLog';
import { scheduleWorkerReconcile } from '../mail/external/accountShared';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
} from '../lib/migrationLedger';

const MIGRATION = '0056_retry_parked_mail_accounts';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.7';

/** Accounts per page. A row is a few hundred bytes plus its sealed credential. */
const PAGE_SIZE = 50;

type PageResult = {
	cursor: string;
	isDone: boolean;
	scanned: number;
	retried: number;
	/** The page belonged to a generation a later start or resume replaced; nothing ran. */
	isSuperseded?: boolean;
};

/** Move one page of parked accounts back to `pending`; schedules the next page. */
export const retryPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), generation: v.number() },
	handler: async (ctx, args): Promise<PageResult> => {
		const run = await readMigrationRun(ctx, MIGRATION);
		if (!isCurrentMigrationPage(run, args.generation)) {
			logInfo('migration.0056_retry_parked_mail_accounts.superseded', {
				generation: args.generation,
			});
			return {
				cursor: args.cursor ?? '',
				isDone: false,
				scanned: 0,
				retried: 0,
				isSuperseded: true,
			};
		}

		const { page, continueCursor, isDone } = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_status', (q) => q.eq('status', 'auth_error'))
			.paginate({ numItems: PAGE_SIZE, cursor: args.cursor });
		const now = Date.now();
		let retried = 0;
		for (const account of page) {
			if (account.purpose === 'seed') continue;
			await ctx.db.patch(account._id, { status: 'pending', lastError: undefined, updatedAt: now });
			retried += 1;
		}
		if (retried > 0) await scheduleWorkerReconcile(ctx);

		await recordMigrationPage(ctx, run, {
			cursor: continueCursor,
			isDone,
			scanned: page.length,
			changed: retried,
		});
		logInfo('migration.0056_retry_parked_mail_accounts.page', {
			scanned: page.length,
			retried,
			cursor: continueCursor,
			isDone,
			generation: run.generation,
		});
		if (!isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.migrations['0056_retry_parked_mail_accounts'].retryPage,
				{ cursor: continueCursor, generation: run.generation }
			);
		}
		return { cursor: continueCursor, isDone, scanned: page.length, retried };
	},
});

/**
 * Start the walk, or resume an unfinished one from its recorded cursor. A
 * finished migration is left alone unless `restart` is set.
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
		await ctx.scheduler.runAfter(
			0,
			internal.migrations['0056_retry_parked_mail_accounts'].retryPage,
			{ cursor: begun.cursor ?? null, generation: begun.generation }
		);
		logInfo('migration.0056_retry_parked_mail_accounts.started', {
			cursor: begun.cursor ?? null,
			generation: begun.generation,
		});
		return { started: true, generation: begun.generation };
	},
});
