import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { AUDIT_LOG_RETENTION_MS } from '../lib/constants';

const CLEANUP_BATCH_SIZE = 100;

// Clean up webhook delivery logs older than retention period in batches
export const cleanupOldLogs = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - AUDIT_LOG_RETENTION_MS;
		let deletedCount = 0;

		// Clean up old success logs (batch limited)
		const successLogs = await ctx.db
			.query('webhookDeliveryLogs')
			.withIndex('by_status', (q) => q.eq('status', 'success'))
			.filter((q) => q.lt(q.field('completedAt'), cutoff))
			.take(CLEANUP_BATCH_SIZE);

		for (const log of successLogs) {
			await ctx.db.delete(log._id);
			deletedCount++;
		}

		// Clean up old failed logs (batch limited)
		const failedLogs = await ctx.db
			.query('webhookDeliveryLogs')
			.withIndex('by_status', (q) => q.eq('status', 'failed'))
			.filter((q) => q.lt(q.field('completedAt'), cutoff))
			.take(CLEANUP_BATCH_SIZE);

		for (const log of failedLogs) {
			await ctx.db.delete(log._id);
			deletedCount++;
		}

		// If we hit the batch limit, schedule another run
		if (successLogs.length === CLEANUP_BATCH_SIZE || failedLogs.length === CLEANUP_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.webhooks.cleanup.cleanupOldLogs, {});
		}

		return { deletedCount };
	},
});
