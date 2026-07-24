import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { AUDIT_LOG_RETENTION_MS } from '../lib/constants';

const CLEANUP_BATCH_SIZE = 100;

/** Delete expired campaign-alert receipts without an unbounded table scan. */
export const cleanupCampaignAlertReceipts = internalMutation({
	args: {},
	handler: async (ctx) => {
		const expired = await ctx.db
			.query('mtaCampaignAlertReceipts')
			.withIndex('by_expires_at', (q) => q.lt('expiresAt', Date.now()))
			.take(CLEANUP_BATCH_SIZE);
		for (const receipt of expired) await ctx.db.delete(receipt._id);
		if (expired.length === CLEANUP_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.webhooks.cleanup.cleanupCampaignAlertReceipts, {});
		}
		return { deletedCount: expired.length };
	},
});

// Clean up webhook delivery logs older than retention period in batches
export const cleanupOldLogs = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - AUDIT_LOG_RETENTION_MS;
		let deletedCount = 0;

		// Clean up old success logs (batch limited)
		const successLogs = await ctx.db
			.query('webhookDeliveryLogs')
			.withIndex('by_status_and_completed_at', (q) =>
				q.eq('status', 'success').lt('completedAt', cutoff)
			)
			.take(CLEANUP_BATCH_SIZE);

		for (const log of successLogs) {
			await ctx.db.delete(log._id);
			deletedCount++;
		}

		// Clean up old failed logs (batch limited)
		const failedLogs = await ctx.db
			.query('webhookDeliveryLogs')
			.withIndex('by_status_and_completed_at', (q) =>
				q.eq('status', 'failed').lt('completedAt', cutoff)
			)
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
