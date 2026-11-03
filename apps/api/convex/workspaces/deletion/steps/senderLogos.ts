import { defineStep, DEFAULT_BATCH_SIZE } from './_common';

/**
 * Storage-bearing step: a found `senderLogos` row owns its stored image. Purge
 * the blob before the row delete so the wipe does not orphan it.
 */
export const senderLogosStep = defineStep({
	table: 'senderLogos',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('senderLogos').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			if (row.storageId) await ctx.storage.delete(row.storageId);
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
