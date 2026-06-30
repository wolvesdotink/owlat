/**
 * IP Pool Management
 *
 * Manages sending IPs with round-robin selection within pools,
 * integrated with DNSBL checking (blocked IPs are excluded).
 */

import type Redis from 'ioredis';
import type { IpPoolType, IpPoolConfig } from '../types.js';
import { logger } from '../monitoring/logger.js';

const IP_POOL_ACTIVE = 'mta:ip-pool:active';
const COUNTER_PREFIX = 'mta:ip-rr:';

/**
 * Select an IP from the appropriate pool using round-robin
 * Respects DNSBL blocks — only returns active (non-blocked) IPs.
 *
 * @returns The selected IP address, or null if no IPs are available
 */
export async function selectIp(
	redis: Redis,
	pool: IpPoolType,
	config: IpPoolConfig,
	dedicatedIp?: string
): Promise<string | null> {
	// If dedicated IP specified and it's active, use it
	if (dedicatedIp) {
		const activeIps = await redis.smembers(IP_POOL_ACTIVE);
		if (activeIps.includes(dedicatedIp)) return dedicatedIp;
		logger.warn({ dedicatedIp }, 'Dedicated IP not active, falling back to pool');
	}

	const poolIps = config[pool];
	if (poolIps.length === 0) return null;

	// Get the set of currently active (non-blocked) IPs
	const activeIps = await redis.smembers(IP_POOL_ACTIVE);
	const activeSet = new Set(activeIps);

	// Filter pool IPs to only active ones
	const availableIps = poolIps.filter((ip) => activeSet.has(ip));

	if (availableIps.length === 0) {
		// Emergency fallback: if ALL IPs in this pool are blocked,
		// try using any IP from the pool (better to send from a warned IP than not at all)
		logger.error({ pool }, 'No active IPs available for pool, using fallback');
		return poolIps[0] ?? null;
	}

	if (availableIps.length === 1) {
		return availableIps[0]!;
	}

	// Round-robin via Redis counter
	const counterKey = `${COUNTER_PREFIX}${pool}`;
	const counter = await redis.incr(counterKey);
	await redis.expire(counterKey, 86400); // Reset daily

	const index = (counter - 1) % availableIps.length;
	return availableIps[index]!;
}

/**
 * Get all IPs with their status (for health endpoint)
 */
export async function getPoolStatus(redis: Redis, config: IpPoolConfig): Promise<Array<{
	ip: string;
	pool: IpPoolType;
	active: boolean;
}>> {
	const activeIps = await redis.smembers(IP_POOL_ACTIVE);
	const activeSet = new Set(activeIps);
	const result: Array<{ ip: string; pool: IpPoolType; active: boolean }> = [];

	for (const ip of config.transactional) {
		result.push({ ip, pool: 'transactional', active: activeSet.has(ip) });
	}
	for (const ip of config.campaign) {
		result.push({ ip, pool: 'campaign', active: activeSet.has(ip) });
	}

	return result;
}

/**
 * Initialize IP pools in Redis (called on startup)
 */
export async function initializePools(redis: Redis, config: IpPoolConfig): Promise<void> {
	const allIps = [...new Set([...config.transactional, ...config.campaign])];
	if (allIps.length > 0) {
		await redis.sadd(IP_POOL_ACTIVE, ...allIps);
	}
	logger.info({ transactional: config.transactional, campaign: config.campaign }, 'IP pools initialized');
}
