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
import { storeFailed } from './dlq.js';
import { logger } from '../monitoring/logger.js';

const MAX_RETRIES = 5;
const RETRY_DELAYS = [1000, 5000, 15000, 60000, 300000]; // 1s, 5s, 15s, 1m, 5m
const TIMEOUT_MS = 10_000;

/**
 * Send a webhook event to Convex
 *
 * Retries up to 5 times with exponential backoff.
 * On final failure, stores the event in the dead letter queue if Redis is available.
 */
export async function notifyConvex(
	event: MtaWebhookEvent,
	config: MtaConfig,
	redis?: Redis
): Promise<boolean> {
	// Route personal-mailbox deliveries to the dedicated webhook
	const path =
		event.event === 'inbound.mailbox.received' ? '/webhooks/mta-mailbox' : '/webhooks/mta';
	const url = `${config.convexSiteUrl}${path}`;
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

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

			clearTimeout(timeout);

			if (response.ok) {
				logger.debug({ event: event.event, messageId: event.messageId }, 'Convex webhook delivered');
				return true;
			}

			lastError = new Error(`HTTP ${response.status}`);
			logger.warn(
				{ event: event.event, status: response.status, attempt },
				'Convex webhook non-OK response'
			);
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			logger.warn({ event: event.event, attempt, err }, 'Convex webhook failed');
		}

		// Wait before retry (with jitter)
		if (attempt < MAX_RETRIES) {
			const baseDelay = RETRY_DELAYS[attempt] ?? 5000;
			const jitter = Math.random() * baseDelay * 0.2; // ±20% jitter
			await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));
		}
	}

	// All retries exhausted — store in DLQ if Redis available
	if (redis) {
		try {
			await storeFailed(redis, event, lastError?.message ?? 'Unknown error', config);
		} catch (dlqErr) {
			logger.error(
				{ err: dlqErr, event: event.event, messageId: event.messageId },
				'Failed to store event in DLQ — event permanently lost'
			);
		}
	} else {
		logger.error(
			{ event: event.event, messageId: event.messageId },
			'Convex webhook delivery FAILED after all retries (no Redis for DLQ)'
		);
	}

	return false;
}
