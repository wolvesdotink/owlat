import type Redis from 'ioredis';
import { randomUUID } from 'crypto';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { notifyConvex } from './convexNotifier.js';
import { claimEligible, settleClaim } from './dlq.js';

export const WEBHOOK_DLQ_AUTO_RETRY_LIMIT = 8;
export const WEBHOOK_DLQ_SWEEP_BATCH_SIZE = 50;

export function webhookDlqRetryDelayMs(attempts: number): number {
	return Math.min(60_000 * 2 ** Math.max(0, attempts), 60 * 60 * 1000);
}

/** Retry a bounded oldest page; entries remain inspectable after exhaustion. */
export async function sweepWebhookDlq(
	redis: Redis,
	config: MtaConfig,
	now = Date.now()
): Promise<{ delivered: number; attempted: number }> {
	const owner = `sweeper:${randomUUID()}`;
	const entries = await claimEligible(redis, {
		owner,
		now,
		limit: WEBHOOK_DLQ_SWEEP_BATCH_SIZE,
		autoRetryLimit: WEBHOOK_DLQ_AUTO_RETRY_LIMIT,
	});
	let delivered = 0;
	let attempted = 0;
	for (const entry of entries) {
		attempted += 1;
		// Omit Redis so a failed sweep updates this entry instead of nesting a
		// second DLQ record. notifyConvex still applies its bounded HTTP retries.
		if (
			await notifyConvex(entry.event, config, undefined, {
				deadline: entry.claim.expiresAt - 5_000,
			})
		) {
			if (await settleClaim(redis, entry, 'success', now)) delivered += 1;
			continue;
		}
		await settleClaim(redis, entry, 'failure', now);
	}
	if (attempted > 0) {
		logger.info(
			{ operation: 'convex_webhook_dlq', attempted, delivered },
			'Automatic webhook DLQ recovery sweep completed'
		);
	}
	return { delivered, attempted };
}
