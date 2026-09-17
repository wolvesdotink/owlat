import { defineStep, DEFAULT_BATCH_SIZE } from './_common';
import { deleteMessageRowAndBlobs } from '../../../mail/messagePurge';

/**
 * Storage-bearing step: each `mailMessages` row carries up to three
 * storage references — `rawStorageId` (mandatory; the raw RFC822),
 * `textBodyStorageId` and `htmlBodyStorageId` (optional inline-extracted
 * bodies). Each must be purged with its row (drift #3) — through the shared
 * refcount-aware `deleteMessageRowAndBlobs`, because IMAP COPY lets several rows
 * share one blob and this step walks the table in batches: a blob is freed with
 * its LAST referencing row, whichever batch that lands in.
 */
export const mailMessagesStep = defineStep({
	table: 'mailMessages',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('mailMessages').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			await deleteMessageRowAndBlobs(ctx, row);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
