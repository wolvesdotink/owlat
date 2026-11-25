/**
 * Fill `emailTemplates.nameSortKey` on rows written before it existed
 * (migration 0077).
 *
 *   npx convex run migrations/0077_backfill_template_name_sort_key:run
 *
 * The template list's name sort reads the `*_name_sort_key` indexes. A row
 * without the key sorts before every named row there, so until the walk has
 * completed, an older template shows first under "Name (A-Z)" and last under
 * "Name (Z-A)". Every write that sets `name` sets the key too.
 *
 * One sweep over the whole table in creation order, Recently deleted rows
 * included so a restored template sorts by name as well. A page writes only
 * rows whose key differs from `templateNameSortKey(name)`, so a page is
 * idempotent. Each page records its cursor in the migration ledger
 * (`migrationRuns` row `0077_backfill_template_name_sort_key`,
 * lib/migrationLedger.ts) before the next is scheduled. Running `run` again on
 * an unfinished walk resumes it; on a finished one it does nothing
 * (`'{"restart":true}'` starts over).
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
import { templateNameSortKey } from '../emailTemplates/listing';

export const MIGRATION = '0077_backfill_template_name_sort_key';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.26';
/** A template row carries its content and HTML, so pages stay small. */
export const PAGE_SIZE = 50;

export async function backfillPage(ctx: MutationCtx, cursor: string | null) {
	const page = await ctx.db.query('emailTemplates').paginate({ numItems: PAGE_SIZE, cursor });
	let changed = 0;
	for (const template of page.page) {
		const nameSortKey = templateNameSortKey(template.name);
		if (template.nameSortKey === nameSortKey) continue;
		await ctx.db.patch(template._id, { nameSortKey });
		changed++;
	}
	return {
		cursor: page.continueCursor,
		isDone: page.isDone,
		scanned: page.page.length,
		changed,
	};
}

/** Run one page and schedule the next one of the same run. */
export const processPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), generation: v.number() },
	handler: async (ctx, args): Promise<{ isDone: boolean; isSuperseded?: boolean }> => {
		const run = await readMigrationRun(ctx, MIGRATION);
		if (!isCurrentMigrationPage(run, args.generation)) {
			logInfo('migration.0077_backfill_template_name_sort_key.superseded', {
				generation: args.generation,
			});
			return { isDone: false, isSuperseded: true };
		}
		const result = await backfillPage(ctx, args.cursor);
		await recordMigrationPage(ctx, run, result);
		logInfo('migration.0077_backfill_template_name_sort_key.page', {
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
				internal.migrations['0077_backfill_template_name_sort_key'].processPage,
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
			internal.migrations['0077_backfill_template_name_sort_key'].processPage,
			{ cursor, generation: begun.generation }
		);
		logInfo('migration.0077_backfill_template_name_sort_key.started', {
			cursor,
			generation: begun.generation,
		});
		return { started: true, generation: begun.generation };
	},
});
