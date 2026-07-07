import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { AUDIT_LOG_RETENTION_MS } from '../lib/constants';

const CLEANUP_BATCH_SIZE = 100;

// Drain a deleted webhook's delivery logs in batches. `webhooks.remove` deletes
// the webhook (and audit-logs the action) synchronously, then schedules this to
// clear the potentially-large log history without blowing the mutation's
// document limit. The orphaned logs are keyed by `webhookId`; nothing reads a
// deleted webhook's logs (getDeliveryStats early-returns on the missing webhook).
export const deleteWebhookLogs = internalMutation({
	args: { webhookId: v.id('webhooks') },
	handler: async (ctx, args) => {
		const batch = await ctx.db
			.query('webhookDeliveryLogs')
			.withIndex('by_webhook', (q) => q.eq('webhookId', args.webhookId))
			.take(CLEANUP_BATCH_SIZE);

		for (const log of batch) {
			await ctx.db.delete(log._id);
		}

		if (batch.length === CLEANUP_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.webhooks.cleanup.deleteWebhookLogs, args);
		}
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
