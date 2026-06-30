/**
 * [10] Graceful Degradation Handler
 *
 * Monitors system health and applies back-pressure or failover
 * when infrastructure components fail.
 */

import type Redis from 'ioredis';
import { isRedisHealthy } from '../redis.js';
import { logger } from '../monitoring/logger.js';

const BACKPRESSURE_QUEUE_THRESHOLD = 10_000;
const DOMAIN_FAILURE_BASE_MS = 30_000;
const DOMAIN_FAILURE_MAX_MS = 600_000;
const DOMAIN_FAILURE_PREFIX = 'mta:domain-fail:';

export interface DegradationState {
	redisHealthy: boolean;
	backpressure: boolean;
	allIpsBlocked: boolean;
}

/**
 * Check overall system health for the /send endpoint
 * Returns the degradation state which determines if new work can be accepted
 */
export async function checkSystemHealth(redis: Redis): Promise<DegradationState> {
	const redisOk = await isRedisHealthy();
	let backpressure = false;
	let allIpsBlocked = false;

	if (redisOk) {
		// Check queue depth for back-pressure
		// GroupMQ stores pending jobs — we check an approximate depth
		try {
			const depth = await redis.get('mta:metrics:total-pending');
			if (depth && parseInt(depth, 10) > BACKPRESSURE_QUEUE_THRESHOLD) {
				backpressure = true;
			}
		} catch {
			// Non-critical
		}

		// Check if all IPs are blocked
		try {
			allIpsBlocked = (await redis.get('mta:emergency:all_ips_blocked')) === '1';
		} catch {
			// Non-critical
		}
	}

	return {
		redisHealthy: redisOk,
		backpressure,
		allIpsBlocked,
	};
}

/**
 * Check if sends to a specific domain should be backed off
 * (connection-level failures, distinct from SMTP-level throttle/intel)
 */
export async function shouldBackoffDomain(redis: Redis, domain: string): Promise<{
	backoff: boolean;
	retryAfter?: number;
}> {
	const key = `${DOMAIN_FAILURE_PREFIX}${domain}`;
	const data = await redis.get(key);
	if (!data) return { backoff: false };

	const retryAt = parseInt(data, 10);
	const now = Date.now();
	if (now >= retryAt) {
		await redis.del(key);
		return { backoff: false };
	}

	return { backoff: true, retryAfter: retryAt - now };
}

/**
 * Record a domain connection failure (TCP-level, not SMTP)
 * Applies exponential backoff per domain
 */
export async function recordDomainFailure(redis: Redis, domain: string): Promise<void> {
	const key = `${DOMAIN_FAILURE_PREFIX}${domain}`;
	const countKey = `${DOMAIN_FAILURE_PREFIX}${domain}:count`;

	const count = await redis.incr(countKey);
	await redis.expire(countKey, 3600); // Reset failure count after 1 hour of no failures

	const delay = Math.min(DOMAIN_FAILURE_BASE_MS * Math.pow(2, count - 1), DOMAIN_FAILURE_MAX_MS);
	const retryAt = Date.now() + delay;

	await redis.set(key, String(retryAt), 'PX', delay);

	logger.warn({ domain, delay, failureCount: count }, 'Domain connection failure — backing off');
}

/**
 * Clear domain failure state (on successful connection)
 */
export async function clearDomainFailure(redis: Redis, domain: string): Promise<void> {
	await redis.del(`${DOMAIN_FAILURE_PREFIX}${domain}`, `${DOMAIN_FAILURE_PREFIX}${domain}:count`);
}
