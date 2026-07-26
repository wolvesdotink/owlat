import { defineStep, DEFAULT_BATCH_SIZE } from './_common';

/** Purge staged GDPR-export blobs before deleting their artifact rows. */
export const accountExportArtifactsStep = defineStep({
	table: 'accountExportArtifacts',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('accountExportArtifacts').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			await ctx.storage.delete(row.storageId);
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
