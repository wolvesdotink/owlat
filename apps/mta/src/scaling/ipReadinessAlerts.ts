/** Durable handoff from atomic readiness transitions into the webhook outbox. */

import type Redis from 'ioredis';
import { isMtaWebhookEvent } from '@owlat/shared/mtaWebhookEvent';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';
import type { MtaWebhookEvent } from '../types.js';
import { queueConvexWebhook } from '../webhooks/convexNotifier.js';
import { IP_READINESS_ALERTS_PENDING } from './ipPool.js';

export const IP_READINESS_ALERT_FLUSH_BATCH_SIZE = 100;

export async function flushPendingIpReadinessAlerts(
	redis: Redis,
	config: MtaConfig
): Promise<number> {
	const [, entries] = await redis.hscan(
		IP_READINESS_ALERTS_PENDING,
		'0',
		'COUNT',
		IP_READINESS_ALERT_FLUSH_BATCH_SIZE
	);
	let queued = 0;
	const boundedEntryCount = Math.min(entries.length, IP_READINESS_ALERT_FLUSH_BATCH_SIZE * 2);
	for (let index = 0; index < boundedEntryCount; index += 2) {
		const eventId = entries[index]!;
		const raw = entries[index + 1]!;
		const [readinessCheck, readinessReason, timestamp, message, ip, eligibilityGeneration] =
			raw.split('\x1f');
		const parsed: unknown = {
			event: 'ip.readiness_regressed',
			eventId,
			readinessCheck,
			readinessReason,
			timestamp: Number(timestamp),
			message,
			ip,
			eligibilityGeneration: Number(eligibilityGeneration),
		};
		if (!isMtaWebhookEvent(parsed) || parsed.event !== 'ip.readiness_regressed') {
			logger.error({ eventId }, 'Discarding invalid pending IP-readiness alert');
			await redis.hdel(IP_READINESS_ALERTS_PENDING, eventId);
			continue;
		}
		await queueConvexWebhook(parsed as MtaWebhookEvent, config, redis, eventId);
		await redis.hdel(IP_READINESS_ALERTS_PENDING, eventId);
		queued += 1;
	}
	return queued;
}
