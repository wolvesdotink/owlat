import { defineStep, DEFAULT_BATCH_SIZE } from './_common';

/**
 * Storage-bearing step: a team-inbox row carries the sealed raw `.eml` the
 * inbound route received, in `rawStorageId`.
 *
 * It rode the generic `makeSweepStep` until the raw bytes existed, and a
 * row-only delete now leaves the whole message — bodies, headers, every
 * attachment — sitting in `_storage` after its workspace is gone. Nothing ever
 * reclaims it either: the inbound retention sweep finds blobs by walking
 * `inboundMessages` rows, and the rows are what this step just deleted. Same
 * shape as `mailMessagesStep`, for the same reason.
 *
 * Absent on a message the retention sweep already released and on one that
 * arrived through the legacy route without bytes, so the delete is guarded.
 */
export const inboundMessagesStep = defineStep({
	table: 'inboundMessages',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('inboundMessages').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			if (row.rawStorageId) await ctx.storage.delete(row.rawStorageId);
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
