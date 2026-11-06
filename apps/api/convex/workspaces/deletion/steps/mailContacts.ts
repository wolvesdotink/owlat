import { defineStep, DEFAULT_BATCH_SIZE } from './_common';
import { deleteBlobQuietly } from '../../../lib/storageBlobs';

/**
 * Storage-bearing step: an address-book row owns the picture a vCard import or
 * a CardDAV sync stored for it. Purge the blob before the row delete so the
 * wipe does not orphan it.
 */
export const mailContactsStep = defineStep({
	table: 'mailContacts',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('mailContacts').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			if (row.photoStorageId) {
				await deleteBlobQuietly(ctx.storage, row.photoStorageId, '[workspace deletion] contact', {
					rowId: row._id,
				});
			}
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
