import type Redis from 'ioredis';
import { randomUUID } from 'crypto';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { notifyConvex } from './convexNotifier.js';
import { claimOne, listEligibleIds, settleClaim, WEBHOOK_DLQ_AUTO_RETRY_LIMIT } from './dlq.js';

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
		// Omit Redis so a failed sweep updates this entry instead of nesting a
		// second DLQ record. notifyConvex still applies its bounded HTTP retries.
		if (
			await notifyConvex(entry.event, config, undefined, {
				deadline: entry.claim.expiresAt - 5_000,
			})
		) {
			if (await settleClaim(redis, entry, 'success', clock())) delivered += 1;
			continue;
		}
		await settleClaim(redis, entry, 'failure', clock());
	}
	if (attempted > 0) {
		logger.info(
			{ operation: 'convex_webhook_dlq', attempted, delivered },
			'Automatic webhook DLQ recovery sweep completed'
		);
	}
	return { delivered, attempted };
}
