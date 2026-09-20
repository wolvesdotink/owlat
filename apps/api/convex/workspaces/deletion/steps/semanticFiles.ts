import { defineStep, DEFAULT_BATCH_SIZE } from './_common';
import { deleteBlobQuietly } from '../../../lib/storageBlobs';

/**
 * Storage-bearing step: each `semanticFiles` row references a blob via
 * `storageId`. Purge before row delete (drift #3) — and a blob already gone out
 * of band is logged rather than thrown, or this batch never deletes and the
 * deletion walker retries it on every hop.
 */
export const semanticFilesStep = defineStep({
	table: 'semanticFiles',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('semanticFiles').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			// A row whose bytes the retention sweep already released has no blob.
			if (row.storageId) {
				await deleteBlobQuietly(ctx.storage, row.storageId, '[workspace deletion] semantic file', {
					rowId: row._id,
				});
			}
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
