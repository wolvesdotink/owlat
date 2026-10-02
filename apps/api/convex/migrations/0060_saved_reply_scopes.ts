/**
 * Give every snippet written before saved replies its scope (migration 0060).
 *
 * Snippets used to belong to one mailbox. Saved replies belong to a person
 * (personal) or to the organization (shared, optionally limited to some team
 * inboxes). A row on a personal mailbox becomes its owner's personal reply; a
 * row on a team inbox becomes a shared reply limited to that inbox. Both keep
 * their `mailboxId`, so the previous release's snippet API, still called from
 * tabs opened before the deploy, keeps finding them.
 *
 *   npx convex run migrations/0060_saved_reply_scopes:run
 *
 * Optional: until it has run, every reader derives the same scope from the
 * row's mailbox (`mail/savedReplyRules.ts:savedReplyScope`). What it changes
 * is that the rows are then found by their owner's and their organization's
 * indexes, and that member erasure reaches a personal reply by its owner.
 * A row whose mailbox is gone or is a deliverability seed has no scope to
 * give; it is left as it is and its id logged.
 *
 * DURABLE AND RESUMABLE: `run` schedules the first page; each page is its own
 * mutation over the rows without a scope and an organization (the
 * `by_organization_and_scope` range they share) that schedules the next one.
 * Progress and completion live in the migration ledger (`migrationRuns` row
 * `0060_saved_reply_scopes`, lib/migrationLedger.ts). Running `run` again on an
 * unfinished pass resumes it; on a finished one it does nothing. Pages are
 * idempotent: a scoped row has left the range the walk reads.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { logInfo, logWarn } from '../lib/runtimeLog';
import { savedReplyScope, scopeFields } from '../mail/savedReplyRules';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
} from '../lib/migrationLedger';

const MIGRATION = '0060_saved_reply_scopes';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.8';

/** Rows per page. A row is a reply's HTML (at most 64 KB) plus its mailbox read. */
const PAGE_SIZE = 50;

type PageResult = {
	cursor: string;
	isDone: boolean;
	scanned: number;
	scoped: number;
	/** The page belonged to a generation a later start or resume replaced; nothing ran. */
	isSuperseded?: boolean;
};

/** Scope one page of legacy rows; schedules the next page. */
export const scopePage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), generation: v.number() },
	handler: async (ctx, args): Promise<PageResult> => {
		const run = await readMigrationRun(ctx, MIGRATION);
		if (!isCurrentMigrationPage(run, args.generation)) {
			logInfo('migration.0060_saved_reply_scopes.superseded', { generation: args.generation });
			return {
				cursor: args.cursor ?? '',
				isDone: false,
				scanned: 0,
				scoped: 0,
				isSuperseded: true,
			};
		}

		const { page, continueCursor, isDone } = await ctx.db
			.query('mailSnippets')
			.withIndex('by_organization_and_scope', (q) =>
				q.eq('organizationId', undefined).eq('scope', undefined)
			)
			.paginate({ numItems: PAGE_SIZE, cursor: args.cursor });
		let scoped = 0;
		const unmapped: string[] = [];
		for (const row of page) {
			const mailbox = row.mailboxId ? await ctx.db.get(row.mailboxId) : null;
			const scope = savedReplyScope(row, mailbox);
			if (!scope) {
				unmapped.push(row._id);
				continue;
			}
			await ctx.db.patch(row._id, scopeFields(scope));
			scoped += 1;
		}
		if (unmapped.length > 0) {
			logWarn('migration.0060_saved_reply_scopes.unmapped', { snippetIds: unmapped });
		}

		await recordMigrationPage(ctx, run, {
			cursor: continueCursor,
			isDone,
			scanned: page.length,
			changed: scoped,
		});
		logInfo('migration.0060_saved_reply_scopes.page', {
			scanned: page.length,
			scoped,
			cursor: continueCursor,
			isDone,
			generation: run.generation,
		});
		if (!isDone) {
			await ctx.scheduler.runAfter(0, internal.migrations['0060_saved_reply_scopes'].scopePage, {
				cursor: continueCursor,
				generation: run.generation,
			});
		}
		return { cursor: continueCursor, isDone, scanned: page.length, scoped };
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
		await ctx.scheduler.runAfter(0, internal.migrations['0060_saved_reply_scopes'].scopePage, {
			cursor: begun.cursor ?? null,
			generation: begun.generation,
		});
		logInfo('migration.0060_saved_reply_scopes.started', {
			cursor: begun.cursor ?? null,
			generation: begun.generation,
		});
		return { started: true, generation: begun.generation };
	},
});
