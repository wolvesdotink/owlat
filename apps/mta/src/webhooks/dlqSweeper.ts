import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { notifyConvex } from './convexNotifier.js';
import { listOldest, removeOne, updateEntry } from './dlq.js';

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
	const entries = await listOldest(redis, WEBHOOK_DLQ_SWEEP_BATCH_SIZE);
	let delivered = 0;
	let attempted = 0;
	for (const entry of entries) {
		if (entry.attempts >= WEBHOOK_DLQ_AUTO_RETRY_LIMIT) continue;
		const dueAt = (entry.lastRetryAt ?? entry.createdAt) + webhookDlqRetryDelayMs(entry.attempts);
		if (dueAt > now) continue;
		attempted += 1;
		// Omit Redis so a failed sweep updates this entry instead of nesting a
		// second DLQ record. notifyConvex still applies its bounded HTTP retries.
		if (await notifyConvex(entry.event, config)) {
			await removeOne(redis, entry.dlqId);
			delivered += 1;
			continue;
		}
		await updateEntry(redis, {
			...entry,
			attempts: entry.attempts + 1,
			lastRetryAt: now,
		});
	}
	if (attempted > 0) {
		logger.info(
			{ operation: 'convex_webhook_dlq', attempted, delivered },
			'Automatic webhook DLQ recovery sweep completed'
		);
	}
	return { delivered, attempted };
}
