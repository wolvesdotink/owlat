import { defineStep, DEFAULT_BATCH_SIZE } from './_common';

/**
 * Storage-bearing step: each `mailMessages` row carries up to three
 * storage references — `rawStorageId` (mandatory; the raw RFC822),
 * `textBodyStorageId` and `htmlBodyStorageId` (optional inline-extracted
 * bodies). Each must be purged before row delete (drift #3).
 */
export const mailMessagesStep = defineStep({
	table: 'mailMessages',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('mailMessages').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			await ctx.storage.delete(row.rawStorageId);
			if (row.textBodyStorageId) await ctx.storage.delete(row.textBodyStorageId);
			if (row.htmlBodyStorageId) await ctx.storage.delete(row.htmlBodyStorageId);
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
