import { defineStep, DEFAULT_BATCH_SIZE } from './_common';

/**
 * Storage-bearing step: an archive-import job that is still `importing` holds
 * the uploaded `.mbox`/`.eml` in `storageId` (a finished job has already
 * dropped it). Purge the blob before the row so a wipe mid-import doesn't
 * orphan billable bytes — the same reasoning as `mediaAssets`.
 */
export const mailArchiveImportsStep = defineStep({
	table: 'mailArchiveImports',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('mailArchiveImports').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			if (row.storageId) await ctx.storage.delete(row.storageId);
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
