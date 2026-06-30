/**
 * Webhook Dead Letter Queue
 *
 * Stores failed webhook events in Redis for later retry or inspection.
 * Prevents permanent event loss when the Convex backend is unreachable.
 */

import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import type { MtaWebhookEvent } from '../types.js';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';

const DLQ_SORTED_SET = 'mta:dlq';
const DLQ_ENTRY_PREFIX = 'mta:dlq:entry:';

export interface DlqEntry {
	dlqId: string;
	event: MtaWebhookEvent;
	error: string;
	attempts: number;
	createdAt: number;
	lastRetryAt?: number;
}

/**
 * Store a failed webhook event in the DLQ
 */
export async function storeFailed(
	redis: Redis,
	event: MtaWebhookEvent,
	error: string,
	config: MtaConfig
): Promise<string> {
	const dlqId = randomUUID();
	const entry: DlqEntry = {
		dlqId,
		event,
		error,
		attempts: 0,
		createdAt: Date.now(),
	};

	const pipeline = redis.pipeline();

	// Store full entry data
	pipeline.set(`${DLQ_ENTRY_PREFIX}${dlqId}`, JSON.stringify(entry));

	// Add to sorted set (score = timestamp for ordering)
	pipeline.zadd(DLQ_SORTED_SET, String(entry.createdAt), dlqId);

	// Trim to max size (remove oldest entries)
	pipeline.zremrangebyrank(DLQ_SORTED_SET, 0, -(config.webhookDlqMaxSize + 1));

	await pipeline.exec();

	logger.warn(
		{ dlqId, eventType: event.event, messageId: event.messageId, error },
		'Webhook event stored in DLQ'
	);

	return dlqId;
}

/**
 * List failed events from the DLQ (newest first)
 */
export async function listFailed(
	redis: Redis,
	limit: number = 50,
	offset: number = 0
): Promise<{ entries: DlqEntry[]; total: number }> {
	const total = await redis.zcard(DLQ_SORTED_SET);
	const dlqIds = await redis.zrevrange(DLQ_SORTED_SET, offset, offset + limit - 1);

	const entries: DlqEntry[] = [];
	for (const dlqId of dlqIds) {
		const data = await redis.get(`${DLQ_ENTRY_PREFIX}${dlqId}`);
		if (data) {
			try {
				entries.push(JSON.parse(data));
			} catch {
				// Skip malformed entries
			}
		}
	}

	return { entries, total };
}

/**
 * Get a specific DLQ entry
 */
export async function getEntry(redis: Redis, dlqId: string): Promise<DlqEntry | null> {
	const data = await redis.get(`${DLQ_ENTRY_PREFIX}${dlqId}`);
	if (!data) return null;
	try {
		return JSON.parse(data);
	} catch {
		return null;
	}
}

/**
 * Remove a specific entry from the DLQ (after successful retry or manual discard)
 */
export async function removeOne(redis: Redis, dlqId: string): Promise<boolean> {
	const pipeline = redis.pipeline();
	pipeline.del(`${DLQ_ENTRY_PREFIX}${dlqId}`);
	pipeline.zrem(DLQ_SORTED_SET, dlqId);
	const results = await pipeline.exec();

	const deleted = results?.[0]?.[1] as number;
	return deleted > 0;
}

/**
 * Update a DLQ entry (e.g., after a retry attempt)
 */
export async function updateEntry(redis: Redis, entry: DlqEntry): Promise<void> {
	await redis.set(`${DLQ_ENTRY_PREFIX}${entry.dlqId}`, JSON.stringify(entry));
}

/**
 * Get DLQ statistics
 */
export async function getStats(redis: Redis): Promise<{
	total: number;
	oldestTimestamp: number | null;
	newestTimestamp: number | null;
}> {
	const total = await redis.zcard(DLQ_SORTED_SET);
	if (total === 0) {
		return { total: 0, oldestTimestamp: null, newestTimestamp: null };
	}

	const oldest = await redis.zrange(DLQ_SORTED_SET, 0, 0, 'WITHSCORES');
	const newest = await redis.zrevrange(DLQ_SORTED_SET, 0, 0, 'WITHSCORES');

	return {
		total,
		oldestTimestamp: oldest[1] ? parseInt(oldest[1], 10) : null,
		newestTimestamp: newest[1] ? parseInt(newest[1], 10) : null,
	};
}

/**
 * Get all DLQ entry IDs for retry-all operations
 */
export async function getAllIds(redis: Redis): Promise<string[]> {
	return redis.zrange(DLQ_SORTED_SET, 0, -1);
}
