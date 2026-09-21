import { defineStep, DEFAULT_BATCH_SIZE } from './_common';

/** Revoke pending capabilities; resource cascades own already-bound blobs. */
export const storageUploadsStep = defineStep({
	table: 'storageUploads',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('storageUploads').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			if (row.storageId && row.status !== 'bound') await ctx.storage.delete(row.storageId);
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
