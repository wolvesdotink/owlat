import { defineStep, DEFAULT_BATCH_SIZE } from './_common';

/**
 * Revoke pending capabilities; resource cascades own already-bound blobs,
 * except a mail thread's held Reply Queue upload (storage/uploads.ts
 * mailThreadUploadKey), which only this receipt names: it goes here.
 */
export const storageUploadsStep = defineStep({
	table: 'storageUploads',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('storageUploads').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			const isThreadHeld = row.resourceKey?.startsWith('mailThreads:') === true;
			if (row.storageId && (row.status !== 'bound' || isThreadHeld)) {
				await ctx.storage.delete(row.storageId);
			}
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
