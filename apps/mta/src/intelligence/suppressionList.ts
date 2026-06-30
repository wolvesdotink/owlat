/**
 * MTA-Level Suppression List
 *
 * Defense-in-depth check before sending to known-bad addresses.
 * Auto-populated on hard bounces and complaints.
 *
 * Uses dual storage:
 * - Redis Set for O(1) lookup (mta:suppressed)
 * - Redis Hash per entry for metadata (mta:suppressed-meta:{email})
 */

import type Redis from 'ioredis';
import { normalizeEmail } from '@owlat/shared';
import { logger } from '../monitoring/logger.js';

const SUPPRESSION_SET = 'mta:suppressed';
const SUPPRESSION_META_PREFIX = 'mta:suppressed-meta:';

export type SuppressionReason = 'hard_bounce' | 'complaint' | 'manual';

/** Default TTL for soft-bounce suppressions (7 days) */
const SOFT_BOUNCE_TTL_SECONDS = 7 * 86400;

export interface SuppressionMeta {
	reason: SuppressionReason;
	source?: string;
	suppressedAt: number;
	expiresAt?: number;
}

/**
 * Check if an email address is on the suppression list
 */
export async function isSuppressed(redis: Redis, email: string): Promise<boolean> {
	const normalized = normalizeEmail(email);
	const isMember = (await redis.sismember(SUPPRESSION_SET, normalized)) === 1;
	if (!isMember) return false;

	// Check if metadata has an expiry
	const meta = await getMetadata(redis, normalized);
	if (meta?.expiresAt && Date.now() > meta.expiresAt) {
		// Expired — auto-remove
		await unsuppress(redis, email);
		return false;
	}

	return true;
}

/**
 * Add an email address to the suppression list
 */
export async function suppress(
	redis: Redis,
	email: string,
	reason: SuppressionReason,
	options?: { source?: string; ttlSeconds?: number }
): Promise<void> {
	const normalized = normalizeEmail(email);
	const now = Date.now();

	const meta: SuppressionMeta = {
		reason,
		source: options?.source,
		suppressedAt: now,
	};

	// Set TTL for soft bounces by default
	const ttl = options?.ttlSeconds ?? (reason === 'hard_bounce' || reason === 'complaint' ? undefined : SOFT_BOUNCE_TTL_SECONDS);
	if (ttl) {
		meta.expiresAt = now + ttl * 1000;
	}

	const pipeline = redis.pipeline();
	pipeline.sadd(SUPPRESSION_SET, normalized);
	pipeline.set(`${SUPPRESSION_META_PREFIX}${normalized}`, JSON.stringify(meta));

	// Set Redis TTL on metadata key for auto-cleanup (if applicable)
	if (ttl) {
		pipeline.expire(`${SUPPRESSION_META_PREFIX}${normalized}`, ttl);
	}

	await pipeline.exec();
	logger.info({ email: normalized, reason, source: options?.source }, 'Address added to suppression list');
}

/**
 * Remove an email address from the suppression list
 */
export async function unsuppress(redis: Redis, email: string): Promise<boolean> {
	const normalized = normalizeEmail(email);
	const pipeline = redis.pipeline();
	pipeline.srem(SUPPRESSION_SET, normalized);
	pipeline.del(`${SUPPRESSION_META_PREFIX}${normalized}`);
	const results = await pipeline.exec();

	const removed = (results?.[0]?.[1] as number) > 0;
	if (removed) {
		logger.info({ email: normalized }, 'Address removed from suppression list');
	}
	return removed;
}

/**
 * Check suppression status with full metadata
 */
export async function getSuppressionStatus(redis: Redis, email: string): Promise<{
	suppressed: boolean;
	reason?: SuppressionReason;
	source?: string;
	suppressedAt?: number;
	expiresAt?: number;
}> {
	const normalized = normalizeEmail(email);
	const isMember = await redis.sismember(SUPPRESSION_SET, normalized);
	if (isMember === 0) return { suppressed: false };

	const meta = await getMetadata(redis, normalized);
	if (!meta) return { suppressed: true };

	// Check expiry
	if (meta.expiresAt && Date.now() > meta.expiresAt) {
		await unsuppress(redis, email);
		return { suppressed: false };
	}

	return {
		suppressed: true,
		reason: meta.reason,
		source: meta.source,
		suppressedAt: meta.suppressedAt,
		expiresAt: meta.expiresAt,
	};
}

/**
 * Bulk suppress multiple addresses
 */
export async function suppressBulk(
	redis: Redis,
	entries: Array<{ email: string; reason: SuppressionReason; source?: string }>
): Promise<{ suppressed: number }> {
	let count = 0;

	// Process in batches of 100 for pipeline efficiency
	for (let i = 0; i < entries.length; i += 100) {
		const batch = entries.slice(i, i + 100);
		const pipeline = redis.pipeline();

		for (const entry of batch) {
			const normalized = normalizeEmail(entry.email);
			const meta: SuppressionMeta = {
				reason: entry.reason,
				source: entry.source,
				suppressedAt: Date.now(),
			};

			pipeline.sadd(SUPPRESSION_SET, normalized);
			pipeline.set(`${SUPPRESSION_META_PREFIX}${normalized}`, JSON.stringify(meta));
		}

		await pipeline.exec();
		count += batch.length;
	}

	logger.info({ count }, 'Bulk suppression completed');
	return { suppressed: count };
}

/**
 * Export suppression list with metadata (paginated via SSCAN)
 */
export async function exportSuppressionList(
	redis: Redis,
	options?: { reason?: SuppressionReason; cursor?: string; limit?: number }
): Promise<{
	entries: Array<{ email: string } & SuppressionMeta>;
	nextCursor?: string;
}> {
	const limit = options?.limit ?? 100;
	const entries: Array<{ email: string } & SuppressionMeta> = [];
	let cursor = options?.cursor ?? '0';

	// We need to scan more than `limit` since we may filter by reason
	const scanCount = Math.max(limit * 3, 300);

	const [nextCursor, members] = await redis.sscan(SUPPRESSION_SET, cursor, 'COUNT', scanCount);

	for (const email of members) {
		if (entries.length >= limit) break;

		const meta = await getMetadata(redis, email);
		if (!meta) continue;

		// Filter by reason if specified
		if (options?.reason && meta.reason !== options.reason) continue;

		entries.push({ email, ...meta });
	}

	return {
		entries,
		nextCursor: nextCursor !== '0' ? nextCursor : undefined,
	};
}

/**
 * Get suppression statistics (counts by reason)
 */
export async function getSuppressionStats(redis: Redis): Promise<{
	total: number;
	byReason: Record<string, number>;
}> {
	const total = await redis.scard(SUPPRESSION_SET);

	// Sample to estimate distribution (full scan would be expensive)
	const byReason: Record<string, number> = {
		hard_bounce: 0,
		complaint: 0,
		manual: 0,
		unknown: 0,
	};

	// Scan a sample of up to 1000 entries
	let cursor = '0';
	let sampled = 0;

	do {
		const [nextCursor, members] = await redis.sscan(SUPPRESSION_SET, cursor, 'COUNT', 200);
		cursor = nextCursor;

		for (const email of members) {
			if (sampled >= 1000) break;
			const meta = await getMetadata(redis, email);
			if (meta?.reason) {
				byReason[meta.reason] = (byReason[meta.reason] ?? 0) + 1;
			} else {
				byReason['unknown'] = (byReason['unknown'] ?? 0) + 1;
			}
			sampled++;
		}
	} while (cursor !== '0' && sampled < 1000);

	// If we sampled less than total, scale up estimates
	if (sampled > 0 && sampled < total) {
		const scale = total / sampled;
		for (const key of Object.keys(byReason)) {
			byReason[key] = Math.round(byReason[key]! * scale);
		}
	}

	return { total, byReason };
}

/**
 * Get metadata for a suppressed email
 */
async function getMetadata(redis: Redis, normalizedEmail: string): Promise<SuppressionMeta | null> {
	const data = await redis.get(`${SUPPRESSION_META_PREFIX}${normalizedEmail}`);
	if (!data) return null;

	try {
		return JSON.parse(data);
	} catch {
		return null;
	}
}
