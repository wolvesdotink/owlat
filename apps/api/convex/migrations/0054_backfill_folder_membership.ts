/**
 * Backfill the IMAP folder membership (#927, migration 0054).
 *
 * Starts the membership walk for every folder that existed before folder
 * membership was maintained. Each walk runs in the background as a chain of
 * bounded mutations (`maintenance/folderMembershipBackfill.ts`); until a folder
 * is ready the IMAP server keeps listing its UIDs from `mailMessages`, exactly
 * as the previous release did, so nothing waits on this.
 *
 *   npx convex run migrations/0054_backfill_folder_membership:run
 *   npx convex run migrations/0054_backfill_folder_membership:status
 *
 * Progress is stored per folder on its `mailFolderMembership` row (cursor,
 * watermark, startedAt, completedAt). Idempotent: a ready folder is left alone
 * and a folder still walking is resumed from its stored cursor, which is also
 * how a run that was interrupted is finished. `'{"rebuild": true}'` drops every
 * folder's membership first and walks again from scratch — the repair for a
 * membership found out of step.
 */

import { v } from 'convex/values';
import { internalAction, internalQuery } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { dropFolderMembership, startFolderMembership } from '../mail/folderMembership';
import { logInfo } from '../lib/runtimeLog';

const PAGE_SIZE = 100;

export const folderPage = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db.query('mailFolders').paginate({ numItems: PAGE_SIZE, cursor });
		return {
			folderIds: result.page.map((folder) => folder._id),
			cursor: result.continueCursor,
			isDone: result.isDone,
		};
	},
});

/** Drop up to one batch of a folder's membership; true while there is more to drop. */
export const dropFolder = internalMutation({
	args: { folderId: v.id('mailFolders') },
	handler: async (ctx, { folderId }) => dropFolderMembership(ctx, folderId),
});

/**
 * Start (or resume) each folder's walk. A new folder gets its state row and a
 * first step; a folder still walking gets another step, which is how a chain
 * that died is picked up again; a ready folder is left alone.
 */
export const startFolders = internalMutation({
	args: { folderIds: v.array(v.id('mailFolders')) },
	handler: async (ctx, { folderIds }) => {
		const outcomes = { started: 0, running: 0, ready: 0 };
		for (const folderId of folderIds) {
			// The folder may have been deleted since `folderPage` listed it; a state
			// row started now would outlive it with nothing left to delete it.
			if (!(await ctx.db.get(folderId))) continue;
			const outcome = await startFolderMembership(ctx, folderId);
			outcomes[outcome] += 1;
			if (outcome === 'ready') continue;
			await ctx.scheduler.runAfter(0, internal.maintenance.folderMembershipBackfill.step, {
				folderId,
			});
		}
		return outcomes;
	},
});

export const run = internalAction({
	args: { rebuild: v.optional(v.boolean()) },
	handler: async (ctx, args): Promise<{ started: number; running: number; ready: number }> => {
		const totals = { started: 0, running: 0, ready: 0 };
		let cursor: string | null = null;
		for (;;) {
			const page: { folderIds: Id<'mailFolders'>[]; cursor: string; isDone: boolean } =
				await ctx.runQuery(internal.migrations['0054_backfill_folder_membership'].folderPage, {
					cursor,
				});
			if (args.rebuild) {
				for (const folderId of page.folderIds) {
					let hasMore = true;
					while (hasMore) {
						hasMore = await ctx.runMutation(
							internal.migrations['0054_backfill_folder_membership'].dropFolder,
							{ folderId }
						);
					}
				}
			}
			const outcome = await ctx.runMutation(
				internal.migrations['0054_backfill_folder_membership'].startFolders,
				{ folderIds: page.folderIds }
			);
			totals.started += outcome.started;
			totals.running += outcome.running;
			totals.ready += outcome.ready;
			if (page.isDone) break;
			cursor = page.cursor;
		}
		logInfo('migration.0054_backfill_folder_membership', totals);
		return totals;
	},
});

/** How far the walks are: folders ready and still walking (first 5,000 folders). */
export const status = internalQuery({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db.query('mailFolderMembership').take(5000);
		const walking = rows.filter((row) => !row.isReady);
		return {
			ready: rows.length - walking.length,
			walking: walking.length,
			walkingFolders: walking.slice(0, 20).map((row) => row.folderId),
		};
	},
});
