import { defineStep, DEFAULT_BATCH_SIZE } from './_common';

/**
 * Storage-bearing step: each `mailDrafts` row has `attachments[]`, where
 * each attachment carries a `storageId`. Purge every blob before the row
 * delete (drift #3).
 */
export const mailDraftsStep = defineStep({
	table: 'mailDrafts',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('mailDrafts').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			for (const att of row.attachments) {
				await ctx.storage.delete(att.storageId);
			}
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
