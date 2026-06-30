import { v } from 'convex/values';
import { internalMutation, internalAction } from '../_generated/server';
import { internal } from '../_generated/api';

/**
 * Webhook Payloads — audit storage for raw webhook bodies.
 *
 * Stores raw webhook payloads for deliverability debugging
 * and bounce/complaint dispute resolution. Records are
 * automatically cleaned up after 90 days.
 */

/**
 * Store a raw webhook payload for audit purposes.
 */
export const store = internalMutation({
	args: {
		source: v.string(), // 'resend' | 'mta' | 'ses'
		rawPayload: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.insert('webhookPayloads', {
			source: args.source,
			rawPayload: args.rawPayload,
			receivedAt: Date.now(),
		});
		return null;
	},
});

/**
 * Clean up webhook payloads older than 90 days.
 * Should be called by a daily cron job.
 */
export const cleanupOldPayloads = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

		// Delete in batches to avoid timeout
		let totalDeleted = 0;
		let hasMore = true;

		while (hasMore) {
			const deleted = await ctx.runMutation(internal.webhooks.payloads.deleteOldBatch, {
				olderThan: ninetyDaysAgo,
				batchSize: 100,
			});
			totalDeleted += deleted;
			hasMore = deleted === 100; // If we deleted a full batch, there might be more
		}

		if (totalDeleted > 0) {
			// eslint-disable-next-line no-console
			console.info(`[Webhook Payloads] Cleaned up ${totalDeleted} payloads older than 90 days`);
		}
		return null;
	},
});

/**
 * Delete a batch of old payloads (internal helper for cleanup action).
 */
export const deleteOldBatch = internalMutation({
	args: {
		olderThan: v.number(),
		batchSize: v.number(),
	},
	handler: async (ctx, args) => {
		const oldPayloads = await ctx.db
			.query('webhookPayloads')
			.withIndex('by_received_at', (q) => q.lt('receivedAt', args.olderThan))
			.take(args.batchSize);

		for (const payload of oldPayloads) {
			await ctx.db.delete(payload._id);
		}

		return oldPayloads.length;
	},
});
