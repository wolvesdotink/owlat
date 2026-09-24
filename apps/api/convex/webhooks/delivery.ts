'use node';

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { hmacSha256Hex } from './security';
import { fetchWithGuardedDispatcher, readBodyPreview, validatePublicUrl } from '../lib/ssrfGuard';

// Result type for the retry-aware delivery action.
interface DeliverWebhookResult {
	success: boolean;
	error?: string;
	retrying?: boolean;
	/** The invocation did not own the current attempt and sent nothing. */
	skipped?: boolean;
}

/** Characters of the receiver's response kept on the delivery log. */
const RESPONSE_PREVIEW_CHARS = 1000;
/**
 * Bytes read to build that preview: enough for RESPONSE_PREVIEW_CHARS of any
 * UTF-8 text (at most 4 bytes per character), and never more.
 */
const RESPONSE_PREVIEW_MAX_BYTES = RESPONSE_PREVIEW_CHARS * 4;
/** How long a receiver may dribble its response body before we stop reading. */
const RESPONSE_PREVIEW_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Bounded excerpt of the receiver's response for the delivery log. The body is
 * diagnostic only: a failed or oversized read never changes the outcome, which
 * the status code alone decides, so a receiver that answered 2xx is never
 * redelivered because its body was huge or broken.
 */
async function previewResponseBody(response: Response): Promise<string> {
	const preview = await readBodyPreview(response.body, {
		maxBytes: RESPONSE_PREVIEW_MAX_BYTES,
		timeoutMs: RESPONSE_PREVIEW_TIMEOUT_MS,
	});
	let text = preview.text;
	let truncated = preview.truncated;
	if (text.length > RESPONSE_PREVIEW_CHARS) {
		// Do not leave half of a surrogate pair at the cut.
		const end = /[\uD800-\uDBFF]/.test(text[RESPONSE_PREVIEW_CHARS - 1] ?? '')
			? RESPONSE_PREVIEW_CHARS - 1
			: RESPONSE_PREVIEW_CHARS;
		text = text.slice(0, end);
		truncated = true;
	}
	return truncated ? `${text}...` : text;
}

// Retry configuration lives in lib/constants; the retry decision is made in
// deliveryQueries.recordDeliveryAttempt, in the same transaction that schedules
// the next attempt. HMAC-SHA256 signing comes from the shared ./security
// primitive (hmacSha256Hex) so this can't diverge from the inbound-adapter /
// channel-webhook copies.

// ============ INTERNAL ACTIONS ============

/**
 * Perform one delivery attempt. Scheduled only by the mutations in
 * `deliveryAttempts.ts` (first attempt, retries, reconciler re-issues), always
 * with the attempt's sequence number; an invocation that does not own the
 * row's current attempt returns without sending.
 */
export const deliverWebhookInternal = internalAction({
	args: {
		webhookId: v.id('webhooks'),
		logId: v.id('webhookDeliveryLogs'),
		// Legacy: invocations scheduled before the row became the source of the
		// body still carry it. The body is now always rebuilt from the row.
		payload: v.optional(v.string()),
		attemptNumber: v.number(),
		attemptSeq: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<DeliverWebhookResult> => {
		const { webhookId, logId, attemptNumber, attemptSeq } = args;
		const attemptRef = { logId, attemptNumber, attemptSeq };

		const claim = await ctx.runMutation(
			internal.webhooks.deliveryQueries.claimDeliveryAttempt,
			attemptRef
		);
		if (claim.kind === 'skip') return { success: false, skipped: true, error: claim.reason };

		const signature = await hmacSha256Hex(claim.secret, claim.payload);
		const timestamp = Math.floor(Date.now() / 1000).toString();

		const startTime = Date.now();
		let httpStatusCode: number | undefined;
		let responseBody: string | undefined;
		let errorMessage: string | undefined;
		let ok = false;

		try {
			const destinationValidation = await validatePublicUrl(claim.url);
			if (!destinationValidation.ok) throw new Error(destinationValidation.error);

			// The guarded dispatcher re-validates the resolved IP at connect time,
			// closing the DNS-rebinding window left open by the up-front
			// validatePublicUrl check (which resolves independently of the socket).
			const response = await fetchWithGuardedDispatcher(claim.url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Signature': signature,
					'X-Timestamp': timestamp,
					'X-Webhook-Id': webhookId,
					// Same value on every retry of this delivery, so a receiver can
					// drop a redelivery it already processed.
					'X-Webhook-Delivery-Id': logId,
					'X-Webhook-Attempt': String(attemptNumber),
					'User-Agent': 'Owlat-Webhooks/1.0',
				},
				body: claim.payload,
				redirect: 'manual',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});

			httpStatusCode = response.status;
			ok = response.ok;
			responseBody = await previewResponseBody(response);
			if (!ok) errorMessage = `HTTP ${httpStatusCode}: ${responseBody}`;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unknown error';
		}

		const outcome = await ctx.runMutation(internal.webhooks.deliveryQueries.recordDeliveryAttempt, {
			...attemptRef,
			ok,
			httpStatusCode,
			responseBody,
			errorMessage,
			durationMs: Date.now() - startTime,
		});

		if (ok) return { success: true };
		return { success: false, retrying: outcome.retrying, error: errorMessage };
	},
});

// Fanout entry points: `webhooks/scheduleFanout.ts` resolves the per-event
// Webhook event module, calls `module.build`, and schedules the enqueue
// mutations in `webhooks/deliveryQueries.ts`, which write the delivery rows and
// schedule this action's first attempts in the same transaction.
