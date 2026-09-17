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
 * Byte budget for one retained body, well inside Convex's 1 MiB per-document
 * limit — the row's other columns (`source`, `receivedAt`, the system fields)
 * live in the remaining quarter.
 *
 * The limit matters because an insert over it THROWS, into callers that
 * deliberately never fail a webhook over its audit trail — which means
 * invisibly. The inbound routes accept bodies far larger than this
 * (`webhooks/pipeline.ts` allows 5 MiB), so before this cap the audit trail was
 * missing exactly for the biggest deliveries, the ones a dispute is most likely
 * to be about.
 */
const MAX_RETAINED_PAYLOAD_BYTES = 768 * 1024;

/**
 * Hard ceiling on what one audit row keeps, in UTF-16 code units.
 *
 * Chosen so the VERBATIM path needs no measuring: a code unit is at most 3
 * bytes of UTF-8 (a surrogate pair is 4 bytes across two units), so 256K units
 * cannot exceed 768 KiB however exotic the body's alphabet. Under this, an
 * adapter that opted into `shouldStoreRawPayload` to replay a disputed batch
 * still gets the body it asked for, byte for byte.
 */
export const MAX_RETAINED_PAYLOAD_CHARS = 256 * 1024;

/**
 * What actually gets stored: the body verbatim, or a marked-truncated envelope.
 *
 * The envelope is NOT bounded by the same character count. `JSON.stringify`
 * escapes a control character to `\u0000` — six bytes for one code unit — so a
 * 256K-unit head of control characters would serialize to 1.5 MiB and throw the
 * insert this cap exists to prevent. There is no way to know the escaped size
 * without escaping, so the head is measured and halved until it fits. For the
 * JSON and form bodies real providers send, the first attempt is the answer.
 */
function retainedPayload(rawPayload: string): string {
	if (rawPayload.length <= MAX_RETAINED_PAYLOAD_CHARS) return rawPayload;
	let headChars = MAX_RETAINED_PAYLOAD_CHARS;
	for (;;) {
		const envelope = JSON.stringify({
			truncated: true,
			originalChars: rawPayload.length,
			head: rawPayload.slice(0, headChars),
		});
		if (headChars === 0) return envelope;
		if (new TextEncoder().encode(envelope).length <= MAX_RETAINED_PAYLOAD_BYTES) return envelope;
		headChars = Math.floor(headChars / 2);
	}
}

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
		await ctx.db.insert('webhookPayloads', {
			source: args.source,
			rawPayload: retainedPayload(args.rawPayload),
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
