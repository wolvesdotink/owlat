import { defineStep, DEFAULT_BATCH_SIZE } from './_common';
import { deleteBlobQuietly } from '../../../lib/storageBlobs';

/**
 * Storage-bearing terminal step: the settings row names the workspace logo
 * files (`logoStorageId`, `logoDarkStorageId`).
 *
 * The `storageUploads` step at the head of the walk drops their receipts but
 * leaves bound blobs to the resource that owns them, and this row is that
 * resource. A generic sweep would delete the row and strand both files in
 * storage with nothing left that names them. A blob already gone is logged,
 * not thrown, so the walk still finishes.
 */
export const instanceSettingsStep = defineStep({
	table: 'instanceSettings',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('instanceSettings').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			for (const storageId of [row.logoStorageId, row.logoDarkStorageId]) {
				if (storageId) {
					await deleteBlobQuietly(ctx.storage, storageId, '[workspace deletion] logo', {
						rowId: row._id,
					});
				}
			}
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
