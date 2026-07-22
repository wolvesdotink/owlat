/** Durable ownership transfer from an MTA worker back to governed Convex routing. */

import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import type { EmailJob } from '../types.js';
import { logger } from '../monitoring/logger.js';
import { queueConvexWebhook } from '../webhooks/convexNotifier.js';
import { releaseRoutingReservations } from './routingReservations.js';

export async function handoffRoutingReentry(
	job: EmailJob,
	deps: { redis: Redis; config: MtaConfig },
	reason: string
): Promise<void> {
	if (!job.routingReentryToken || !job.routingReentry || !job.workAttemptId) {
		throw new Error('Missing routing re-entry context');
	}
	const routingReentryReason = /warming/i.test(reason)
		? ('warming_capacity_changed' as const)
		: /circuit/i.test(reason)
			? ('circuit_breaker_changed' as const)
			: ('routing_lease_stale' as const);
	const event = {
		event: 'routing.reentry',
		messageId: job.messageId,
		routingReentryToken: job.routingReentryToken,
		workAttemptId: job.workAttemptId,
		deliveryDomain: job.deliveryDomain,
		routingReentry: job.routingReentry,
		routingReentryReason,
		timestamp: Date.now(),
	} as const;
	await releaseRoutingReservations(job, deps);
	const outboxId = await queueConvexWebhook(
		event,
		deps.config,
		deps.redis,
		`routing-reentry:${job.workAttemptId}:${job.routingReentryToken}`
	);
	logger.warn(
		{ messageId: job.messageId, routingReentryReason, outboxId },
		'Routing re-entry transferred to the protected webhook outbox'
	);
}
