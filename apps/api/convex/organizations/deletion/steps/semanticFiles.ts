import { defineStep, DEFAULT_BATCH_SIZE } from './_common';

/**
 * Storage-bearing step: each `semanticFiles` row references a blob via
 * `storageId`. Purge before row delete (drift #3).
 */
export const semanticFilesStep = defineStep({
	table: 'semanticFiles',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('semanticFiles').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			await ctx.storage.delete(row.storageId);
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
