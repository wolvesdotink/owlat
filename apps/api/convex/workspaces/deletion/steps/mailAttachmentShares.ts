import { defineStep, DEFAULT_BATCH_SIZE } from './_common';

/**
 * Storage-bearing step: a live `mailAttachmentShares` row owns the blob its
 * link serves — the composer detached it from the draft, so `mailDrafts` no
 * longer knows the id and that step will never reach it. A generic sweep here
 * would delete the row and strand the file in storage forever.
 *
 * `storageId` is absent on rows whose bytes were already reclaimed (revoked, or
 * swept after expiry), which is the common case for old rows; those just delete.
 */
export const mailAttachmentSharesStep = defineStep({
	table: 'mailAttachmentShares',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('mailAttachmentShares').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			if (row.storageId) await ctx.storage.delete(row.storageId);
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
