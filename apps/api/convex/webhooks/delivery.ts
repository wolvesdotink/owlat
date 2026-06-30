'use node';

import { v } from 'convex/values';
import { MAX_WEBHOOK_ATTEMPTS, WEBHOOK_RETRY_DELAYS_MS } from '../lib/constants';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { hmacSha256Hex } from './security';
import { guardedDispatcher, validatePublicUrl } from '../lib/ssrfGuard';

// Result type for the retry-aware delivery action.
interface DeliverWebhookResult {
	success: boolean;
	error?: string;
	retrying?: boolean;
}

// Retry configuration lives in lib/constants (shared with fanout.ts).
// HMAC-SHA256 signing comes from the shared ./security primitive (hmacSha256Hex)
// so this can't diverge from the inbound-adapter / channel-webhook copies.

// ============ INTERNAL ACTIONS ============

/**
 * Internal action to deliver a webhook
 * This is called by the scheduler for retries
 */
export const deliverWebhookInternal = internalAction({
	args: {
		webhookId: v.id('webhooks'),
		logId: v.id('webhookDeliveryLogs'),
		payload: v.string(),
		attemptNumber: v.number(),
	},
	handler: async (ctx, args): Promise<DeliverWebhookResult> => {
		const { webhookId, logId, payload, attemptNumber } = args;

		// Get webhook details
		const webhook = await ctx.runQuery(internal.webhooks.deliveryQueries.getWebhook, {
			webhookId,
		});

		if (!webhook) {
			await ctx.runMutation(internal.webhooks.deliveryQueries.markDeliveryFailed, {
				logId,
				errorMessage: 'Webhook not found',
			});
			return { success: false, error: 'Webhook not found' };
		}

		if (!webhook.isActive) {
			await ctx.runMutation(internal.webhooks.deliveryQueries.markDeliveryFailed, {
				logId,
				errorMessage: 'Webhook is disabled',
			});
			return { success: false, error: 'Webhook is disabled' };
		}

		// Generate HMAC signature
		const signature = await hmacSha256Hex(webhook.secret, payload);
		const timestamp = Math.floor(Date.now() / 1000).toString();

		// Deliver the webhook
		const startTime = Date.now();
		let httpStatusCode: number | undefined;
		let responseBody: string | undefined;
		let errorMessage: string | undefined;

		try {
			const destinationValidation = await validatePublicUrl(webhook.url);
			if (!destinationValidation.ok) {
				errorMessage = destinationValidation.error;
				throw new Error(destinationValidation.error);
			}

			const response = await fetch(webhook.url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Signature': signature,
					'X-Timestamp': timestamp,
					'X-Webhook-Id': webhookId,
					'User-Agent': 'Owlat-Webhooks/1.0',
				},
				body: payload,
				redirect: 'manual',
				signal: AbortSignal.timeout(30000), // 30 second timeout
				// Re-validate the resolved IP at connect time to close the
				// DNS-rebinding window left open by the up-front validatePublicUrl
				// check (which resolves independently of the socket).
				// @ts-expect-error `dispatcher` is an undici-specific fetch option
				// not in the DOM RequestInit lib types, but valid in the Node runtime.
				dispatcher: guardedDispatcher(),
			});

			httpStatusCode = response.status;

			// Read response body (truncate if too long)
			const text = await response.text();
			responseBody = text.length > 1000 ? text.substring(0, 1000) + '...' : text;

			const durationMs = Date.now() - startTime;

			// Success: 2xx status codes
			if (response.ok) {
				await ctx.runMutation(internal.webhooks.deliveryQueries.markDeliverySuccess, {
					logId,
					httpStatusCode,
					responseBody,
					durationMs,
				});
				return { success: true };
			}

			// Failed: non-2xx status
			errorMessage = `HTTP ${httpStatusCode}: ${responseBody}`;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unknown error';
		}

		const durationMs = Date.now() - startTime;

		// Check if we should retry
		if (attemptNumber < MAX_WEBHOOK_ATTEMPTS) {
			const nextAttemptNumber = attemptNumber + 1;
			const retryDelayMs = WEBHOOK_RETRY_DELAYS_MS[attemptNumber] || 5 * 60 * 1000; // Default 5 min
			const nextRetryAt = Date.now() + retryDelayMs;

			// Mark as retrying
			await ctx.runMutation(internal.webhooks.deliveryQueries.markDeliveryRetrying, {
				logId,
				httpStatusCode,
				responseBody,
				errorMessage,
				durationMs,
				nextRetryAt,
				newAttemptNumber: nextAttemptNumber,
			});

			// Schedule retry with exponential backoff
			await ctx.scheduler.runAfter(retryDelayMs, internal.webhooks.delivery.deliverWebhookInternal, {
				webhookId,
				logId,
				payload,
				attemptNumber: nextAttemptNumber,
			});

			return { success: false, retrying: true, error: errorMessage };
		}

		// Final failure after all retries
		await ctx.runMutation(internal.webhooks.deliveryQueries.markDeliveryFailed, {
			logId,
			httpStatusCode,
			responseBody,
			errorMessage: errorMessage || 'Max retries exceeded',
			durationMs,
		});

		return { success: false, error: errorMessage };
	},
});

// Fanout entry points (formerly `fireWebhookEvent` and `deliverWebhook`)
// have moved to `webhooks/fanout.ts`. They are no longer scheduled directly
// — callers use the typed helpers in `webhooks/scheduleFanout.ts` which
// resolve the per-event Webhook event module, call `module.build`, and
// then schedule the matching fanout action.
