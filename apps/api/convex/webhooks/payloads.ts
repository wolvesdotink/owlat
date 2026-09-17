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
 * Hard ceiling on what one audit row keeps, in UTF-16 code units.
 *
 * A Convex document is capped at 1 MiB and an insert over that cap THROWS — into
 * callers that deliberately never fail a webhook over its audit trail, which
 * means invisibly. The inbound routes accept bodies far larger than this
 * (`webhooks/pipeline.ts` allows 5 MiB), so without a cap here the audit trail
 * was missing exactly for the biggest deliveries, the ones a dispute is most
 * likely to be about. 64K code units is at most 256 KiB of UTF-8, comfortably
 * inside the document cap, and a marked-truncated head is strictly more audit
 * than the row that was never written.
 */
export const MAX_RETAINED_PAYLOAD_CHARS = 64 * 1024;

/**
 * Store a raw webhook payload for audit purposes.
 *
 * Oversized bodies are retained as a truncation envelope
 * (`{"truncated":true,"originalChars":…,"head":"…"}`) rather than dropped. The
 * mailbox-inbound route does not reach this at all: it hands us a bounded
 * SUMMARY of the delivery, because its body carries the whole message and
 * keeping a second full copy of every email for 90 days is not an audit trail
 * (see `mail/webhookHttp.ts`).
 */
export const store = internalMutation({
	args: {
		// An `InboundAdapter['source']` (`./pipeline.ts`) — see the
		// `webhookPayloads.source` column comment in `schema/webhooks.ts` for what
		// may land here; the kinds are not re-listed at either site (ADR-0055, D10).
		source: v.string(),
		rawPayload: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const rawPayload =
			args.rawPayload.length > MAX_RETAINED_PAYLOAD_CHARS
				? JSON.stringify({
						truncated: true,
						originalChars: args.rawPayload.length,
						head: args.rawPayload.slice(0, MAX_RETAINED_PAYLOAD_CHARS),
					})
				: args.rawPayload;
		await ctx.db.insert('webhookPayloads', {
			source: args.source,
			rawPayload,
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
