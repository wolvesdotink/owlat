import { defineStep, DEFAULT_BATCH_SIZE } from './_common';
import { deleteBlobQuietly } from '../../../lib/storageBlobs';

/**
 * Storage-bearing step: a saved reply's `attachments[]` name the blobs it
 * owns, which drafts only borrow (the `mailDrafts` step skips them). The
 * `storageUploads` step runs first and takes the receipts, so the row is what
 * is left to find them by.
 */
export const mailSnippetsStep = defineStep({
	table: 'mailSnippets',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('mailSnippets').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			for (const file of row.attachments ?? []) {
				await deleteBlobQuietly(ctx.storage, file.storageId, '[workspace deletion] saved reply', {
					rowId: row._id,
				});
			}
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
