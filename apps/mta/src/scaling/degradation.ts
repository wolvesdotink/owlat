/**
 * [10] Graceful Degradation Handler
 *
 * Monitors system health and applies back-pressure or failover
 * when infrastructure components fail.
 */

import type Redis from 'ioredis';
import { isRedisHealthy } from '../redis.js';
import { logger } from '../monitoring/logger.js';
import { createHash } from 'crypto';
import {
	DURABLE_EFFECT_IDEMPOTENCY_TTL_MS,
	type DurableEffectIdentity,
} from '../lib/effectCheckpoint.js';

const BACKPRESSURE_QUEUE_THRESHOLD = 10_000;
const DOMAIN_FAILURE_BASE_MS = 30_000;
const DOMAIN_FAILURE_MAX_MS = 600_000;
const DOMAIN_FAILURE_PREFIX = 'mta:domain-fail:';

const RECORD_DOMAIN_FAILURE_ONCE_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
local count = redis.call('HINCRBY', KEYS[1], 'count', 1)
local delay = math.min(tonumber(ARGV[2]) * (2 ^ (count - 1)), tonumber(ARGV[3]))
redis.call('HSET', KEYS[1], 'retryAt', tostring(tonumber(ARGV[1]) + delay))
redis.call('PEXPIRE', KEYS[1], math.max(3600000, delay))
redis.call('SET', KEYS[2], 'recorded', 'PX', ARGV[4])
return {count, delay}
`;

function domainFailureKey(domain: string): string {
	return `${DOMAIN_FAILURE_PREFIX}{${domain}}:state`;
}

function domainFailureReceiptKey(domain: string, identity: DurableEffectIdentity): string {
	return `${DOMAIN_FAILURE_PREFIX}{${domain}}:effect:${createHash('sha256').update(identity).digest('hex')}`;
}

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
export async function shouldBackoffDomain(
	redis: Redis,
	domain: string
): Promise<{
	backoff: boolean;
	retryAfter?: number;
}> {
	const key = domainFailureKey(domain);
	const data = await redis.hget(key, 'retryAt');
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
export async function recordDomainFailure(
	redis: Redis,
	domain: string,
	idempotencyIdentity?: DurableEffectIdentity
): Promise<void> {
	const key = domainFailureKey(domain);
	if (idempotencyIdentity) {
		const result = (await redis.eval(
			RECORD_DOMAIN_FAILURE_ONCE_LUA,
			2,
			key,
			domainFailureReceiptKey(domain, idempotencyIdentity),
			String(Date.now()),
			String(DOMAIN_FAILURE_BASE_MS),
			String(DOMAIN_FAILURE_MAX_MS),
			String(DURABLE_EFFECT_IDEMPOTENCY_TTL_MS)
		)) as [number, number] | number;
		if (!Array.isArray(result)) return;
		logger.warn(
			{ domain, delay: Number(result[1]), failureCount: Number(result[0]) },
			'Domain connection failure — backing off'
		);
		return;
	}

	const count = await redis.hincrby(key, 'count', 1);

	const delay = Math.min(DOMAIN_FAILURE_BASE_MS * Math.pow(2, count - 1), DOMAIN_FAILURE_MAX_MS);
	const retryAt = Date.now() + delay;

	await redis.hset(key, 'retryAt', String(retryAt));
	await redis.pexpire(key, Math.max(3_600_000, delay));

	logger.warn({ domain, delay, failureCount: count }, 'Domain connection failure — backing off');
}

/**
 * Clear domain failure state (on successful connection)
 */
export async function clearDomainFailure(redis: Redis, domain: string): Promise<void> {
	await redis.del(domainFailureKey(domain));
}
