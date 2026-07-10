import { defineStep, DEFAULT_BATCH_SIZE } from './_common';

/**
 * Storage-bearing step: each `mediaAssets` row references a blob via
 * `storageId`. Purge the blob before the row delete so the org-wipe
 * doesn't orphan billable bytes. Closes drift #3 from ADR-0025.
 */
export const mediaAssetsStep = defineStep({
	table: 'mediaAssets',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('mediaAssets').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			await ctx.storage.delete(row.storageId);
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
