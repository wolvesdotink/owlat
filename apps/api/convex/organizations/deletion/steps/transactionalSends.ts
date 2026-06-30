import type { Id } from '../../../_generated/dataModel';
import { defineStep, DEFAULT_BATCH_SIZE } from './_common';

/**
 * Storage-bearing step: each `transactionalSends` row may carry
 * `attachmentStorageIds: v.array(v.string())` (storage IDs for attachments
 * captured at queue time). Purge every blob before the row delete
 * (drift #3).
 *
 * Normal-flow callers go through the Send lifecycle's
 * `attachment_cleanup` effect on terminal worker outcomes; this step is
 * the wipe-time fallback for any send that never reached terminal.
 */
export const transactionalSendsStep = defineStep({
	table: 'transactionalSends',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('transactionalSends').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			if (row.attachmentStorageIds) {
				for (const sid of row.attachmentStorageIds) {
					await ctx.storage.delete(sid as Id<'_storage'>);
				}
			}
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
