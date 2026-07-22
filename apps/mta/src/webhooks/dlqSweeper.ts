import type Redis from 'ioredis';
import { randomUUID } from 'crypto';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { deliverClaimedWebhook } from './convexNotifier.js';
import { claimOne, listEligibleIds, WEBHOOK_DLQ_AUTO_RETRY_LIMIT } from './dlq.js';

export const WEBHOOK_DLQ_SWEEP_BATCH_SIZE = 50;

/** Retry a bounded due page; each row is leased immediately before its HTTP call. */
export async function sweepWebhookDlq(
	redis: Redis,
	config: MtaConfig,
	clock: () => number = Date.now
): Promise<{ delivered: number; attempted: number }> {
	const owner = `sweeper:${randomUUID()}`;
	const ids = await listEligibleIds(redis, {
		now: clock(),
		limit: WEBHOOK_DLQ_SWEEP_BATCH_SIZE,
		// Scan beyond one batch so stale/corrupt candidates cannot permanently hide
		// newer retryable work. Exhausted rows are retained only in the created index.
		scanLimit: WEBHOOK_DLQ_SWEEP_BATCH_SIZE * 20,
		autoRetryLimit: WEBHOOK_DLQ_AUTO_RETRY_LIMIT,
	});
	let delivered = 0;
	let attempted = 0;
	for (const id of ids) {
		if (attempted >= WEBHOOK_DLQ_SWEEP_BATCH_SIZE) break;
		const entry = await claimOne(redis, id, {
			owner,
			now: clock(),
			requireDue: true,
			enforceAutoLimit: true,
			autoRetryLimit: WEBHOOK_DLQ_AUTO_RETRY_LIMIT,
		});
		if (!entry) continue;
		attempted += 1;
		// Shared delivery settles this exact owner-fenced row instead of nesting a
		// second DLQ record.
		if (
			await deliverClaimedWebhook(redis, entry, config, {
				deadline: entry.claim.expiresAt - 5_000,
				clock,
			})
		)
			delivered += 1;
	}
	if (attempted > 0) {
		logger.info(
			{ operation: 'convex_webhook_dlq', attempted, delivered },
			'Automatic webhook DLQ recovery sweep completed'
		);
	}
	return { delivered, attempted };
}
