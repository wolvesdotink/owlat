import { defineStep, DEFAULT_BATCH_SIZE } from './_common';
import { partBlobIds } from '../../../mail/messageParts';
import { deleteBlobQuietly } from '../../../lib/storageBlobs';

/**
 * Storage-bearing step: each `mailMessageParts` row owns the blobs of the
 * attachment parts cut out of one raw `.eml`. The `mailMessages` step before
 * this one frees them together with their raw blob, so this only meets rows a
 * lost race left behind, and it must still purge their blobs rather than
 * strand them in storage.
 */
export const mailMessagePartsStep = defineStep({
	table: 'mailMessageParts',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('mailMessageParts').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			await ctx.db.delete(row._id);
			for (const storageId of partBlobIds(row)) {
				await deleteBlobQuietly(ctx.storage, storageId, '[workspace deletion] message part', {
					rowId: row._id,
				});
			}
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
