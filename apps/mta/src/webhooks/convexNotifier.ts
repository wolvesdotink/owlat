/**
 * Convex Webhook Notifier
 *
 * POSTs delivery events back to the Convex backend at /webhooks/mta.
 * Includes shared secret authentication, retry logic, and DLQ fallback.
 */

import { createHmac } from 'crypto';
import type Redis from 'ioredis';
import type { MtaWebhookEvent } from '../types.js';
import type { MtaConfig } from '../config.js';
import { classifyWebhookHttpFailure, storeFailed, type WebhookDeliveryFailure } from './dlq.js';
import { logger } from '../monitoring/logger.js';

const MAX_RETRIES = 5;
const RETRY_DELAYS = [1000, 5000, 15000, 60000, 300000]; // 1s, 5s, 15s, 1m, 5m
const TIMEOUT_MS = 10_000;

interface NotifyConvexOptions {
	/** Optional absolute deadline for callers that run inside a bounded sweep. */
	deadline?: number;
}

/**
 * Send a webhook event to Convex
 *
 * Retries up to 5 times with exponential backoff.
 * On final failure, stores the event in the dead letter queue if Redis is available.
 */
export async function notifyConvex(
	event: MtaWebhookEvent,
	config: MtaConfig,
	redis?: Redis,
	options: NotifyConvexOptions = {}
): Promise<boolean> {
	// Route personal-mailbox deliveries to the dedicated webhook
	const path =
		event.event === 'inbound.mailbox.received' ? '/webhooks/mta-mailbox' : '/webhooks/mta';
	const url = `${config.convexSiteUrl}${path}`;
	let deliveryFailure: WebhookDeliveryFailure = { category: 'unknown' };

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const remainingMs = options.deadline ? options.deadline - Date.now() : TIMEOUT_MS;
		if (remainingMs <= 0) {
			deliveryFailure = { category: 'deadline_exhausted' };
			break;
		}
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const controller = new AbortController();
			timeout = setTimeout(() => controller.abort(), Math.min(TIMEOUT_MS, remainingMs));

			const body = JSON.stringify(event);
			const timestamp = String(Math.floor(Date.now() / 1000));
			const signature = createHmac('sha256', config.webhookSecret)
				.update(`${timestamp}.${body}`)
				.digest('hex');

			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-MTA-Timestamp': timestamp,
					'X-MTA-Signature': signature,
				},
				body,
				signal: controller.signal,
			});

			if (response.ok) {
				logger.debug(
					{
						operation: 'convex_webhook',
						category: 'delivered',
						eventType: event.event,
					},
					'Convex webhook delivered'
				);
				return true;
			}

			deliveryFailure = classifyWebhookHttpFailure(response.status);
			logger.warn(
				{
					operation: 'convex_webhook',
					category: 'http',
					status: response.status,
					attempt,
					eventType: event.event,
				},
				'Convex webhook non-OK response'
			);
		} catch {
			deliveryFailure = { category: 'transport' };
			logger.warn(
				{
					operation: 'convex_webhook',
					category: 'transport',
					attempt,
					eventType: event.event,
				},
				'Convex webhook failed'
			);
		} finally {
			if (timeout) clearTimeout(timeout);
		}

		// Wait before retry (with jitter)
		if (attempt < MAX_RETRIES) {
			const baseDelay = RETRY_DELAYS[attempt] ?? 5000;
			const jitter = Math.random() * baseDelay * 0.2; // ±20% jitter
			const delayMs = baseDelay + jitter;
			if (options.deadline && Date.now() + delayMs >= options.deadline) {
				deliveryFailure = { category: 'deadline_exhausted' };
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	// All retries exhausted — store in DLQ if Redis available
	if (redis) {
		try {
			await storeFailed(redis, event, deliveryFailure, config);
		} catch {
			logger.error(
				{
					operation: 'convex_webhook_dlq',
					category: 'storage',
					eventType: event.event,
				},
				'Failed to store event in DLQ — event permanently lost'
			);
		}
	} else {
		logger.error(
			{
				operation: 'convex_webhook_dlq',
				category: 'unavailable',
				eventType: event.event,
			},
			'Convex webhook delivery FAILED after all retries (no Redis for DLQ)'
		);
	}

	return false;
}
