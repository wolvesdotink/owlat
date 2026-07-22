/**
 * Convex Webhook Notifier
 *
 * POSTs delivery events back to the Convex backend at /webhooks/mta.
 * Includes shared secret authentication, retry logic, and DLQ fallback.
 */

import { createHmac, randomUUID } from 'crypto';
import type Redis from 'ioredis';
import type { GooglePostmasterWebhookEvent, MtaWebhookEvent } from '../types.js';
import type { MtaConfig } from '../config.js';
import {
	claimOne,
	classifyWebhookHttpFailure,
	settleClaim,
	storeFailed,
	storePending,
	WEBHOOK_DLQ_AUTO_RETRY_LIMIT,
	type ClaimedDlqEntry,
	type WebhookDeliveryFailure,
} from './dlq.js';
import { logger } from '../monitoring/logger.js';

const MAX_RETRIES = 5;
const RETRY_DELAYS = [1000, 5000, 15000, 60000, 300000]; // 1s, 5s, 15s, 1m, 5m
const TIMEOUT_MS = 10_000;

interface NotifyConvexOptions {
	/** Optional absolute deadline for callers that run inside a bounded sweep. */
	deadline?: number;
	/** Completion clock injected by deterministic sweep tests. */
	clock?: () => number;
}

type SuccessfulResponseDecoder<T> = (response: Response) => Promise<T | null>;

type WebhookDeliveryResult<T> =
	| { delivered: true; acknowledgement: T }
	| { delivered: false; failure: WebhookDeliveryFailure };

export type PostmasterAcknowledgement =
	| { disposition: 'accepted_authorized'; retained: boolean }
	| { disposition: 'ignored_unowned'; retained: false }
	| { disposition: 'delivery_failed'; retained: false };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isPostmasterEvent(event: MtaWebhookEvent): event is GooglePostmasterWebhookEvent {
	return event.event === 'postmaster.authorize_domain' || event.event === 'postmaster.stats';
}

async function deliverWithRetries<T>(
	event: MtaWebhookEvent,
	config: MtaConfig,
	options: NotifyConvexOptions,
	decodeSuccessfulResponse: SuccessfulResponseDecoder<T>
): Promise<WebhookDeliveryResult<T>> {
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
				const acknowledgement = await decodeSuccessfulResponse(response);
				if (acknowledgement !== null) {
					logger.debug(
						{ operation: 'convex_webhook', category: 'delivered', eventType: event.event },
						'Convex webhook delivered'
					);
					return { delivered: true, acknowledgement };
				}
				deliveryFailure = { category: 'unknown' };
			} else {
				deliveryFailure = classifyWebhookHttpFailure(response.status);
			}
			logger.warn(
				{
					operation: 'convex_webhook',
					category: response.ok ? 'invalid_acknowledgement' : 'http',
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

		if (attempt < MAX_RETRIES) {
			const baseDelay = RETRY_DELAYS[attempt] ?? 5000;
			const delayMs = baseDelay + Math.random() * baseDelay * 0.2;
			if (options.deadline && Date.now() + delayMs >= options.deadline) {
				deliveryFailure = { category: 'deadline_exhausted' };
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	return { delivered: false, failure: deliveryFailure };
}

async function decodePostmasterAcknowledgement(
	response: Response,
	expectedKind: 'internal.postmaster_authorize_domain' | 'internal.postmaster_stats'
): Promise<Exclude<PostmasterAcknowledgement, { disposition: 'delivery_failed' }> | null> {
	const body = await response.text();
	if (body.length > 1_024) return null;
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return null;
	}
	if (
		!isRecord(value) ||
		value['success'] !== true ||
		value['kind'] !== expectedKind ||
		value['retained'] === undefined
	)
		return null;
	if (value['disposition'] === 'accepted_authorized' && typeof value['retained'] === 'boolean') {
		return { disposition: 'accepted_authorized', retained: value['retained'] };
	}
	if (value['disposition'] === 'ignored_unowned' && value['retained'] === false) {
		return { disposition: 'ignored_unowned', retained: false };
	}
	return null;
}

/**
 * Purpose-specific Postmaster delivery. Its page checkpoint is the durable
 * retry source, so pre-authorization domain payloads never enter the generic
 * webhook DLQ.
 */
export async function notifyPostmasterConvex(
	event: GooglePostmasterWebhookEvent,
	config: MtaConfig,
	options: NotifyConvexOptions = {}
): Promise<PostmasterAcknowledgement> {
	const expectedKind =
		event.event === 'postmaster.authorize_domain'
			? 'internal.postmaster_authorize_domain'
			: 'internal.postmaster_stats';
	const result = await deliverWithRetries(event, config, options, (response) =>
		decodePostmasterAcknowledgement(response, expectedKind)
	);
	return result.delivered
		? result.acknowledgement
		: { disposition: 'delivery_failed', retained: false };
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
	if (isPostmasterEvent(event)) {
		const result = await notifyPostmasterConvex(event, config, options);
		return result.disposition !== 'delivery_failed';
	}
	const result = await deliverWithRetries(event, config, options, async () => true);
	if (result.delivered) return true;

	// All retries exhausted — store in DLQ if Redis available
	if (redis) {
		try {
			await storeFailed(redis, event, result.failure, config);
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

/**
 * Persist a terminal callback before its GroupMQ job may ACK, then start an
 * immediate owner-fenced attempt. The sweeper recovers the same durable row if
 * that process disappears while the background network request is in flight.
 */
export async function queueConvexWebhook(
	event: MtaWebhookEvent,
	config: MtaConfig,
	redis: Redis,
	idempotencyKey: string
): Promise<string> {
	const dlqId = await storePending(redis, event, config, idempotencyKey);
	const entry = await claimOne(redis, dlqId, {
		owner: `immediate:${randomUUID()}`,
		now: Date.now(),
		requireDue: true,
		enforceAutoLimit: true,
		autoRetryLimit: WEBHOOK_DLQ_AUTO_RETRY_LIMIT,
	});
	if (entry) {
		deliverClaimedWebhook(redis, entry, config).catch((err) =>
			logger.error(
				{ err, operation: 'convex_webhook_outbox', eventType: event.event, dlqId },
				'Durable webhook outbox delivery attempt failed'
			)
		);
	}
	return dlqId;
}

/** Shared owner-fenced delivery path for immediate attempts and sweeper recovery. */
export async function deliverClaimedWebhook(
	redis: Redis,
	entry: ClaimedDlqEntry,
	config: MtaConfig,
	options: NotifyConvexOptions = {}
): Promise<boolean> {
	const result = await deliverWithRetries(entry.event, config, options, async () => true);
	if (result.delivered) {
		return await settleClaim(redis, entry, 'success', options.clock?.() ?? Date.now());
	}
	await settleClaim(redis, entry, 'failure', options.clock?.() ?? Date.now(), result.failure);
	return false;
}
