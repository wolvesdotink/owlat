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
const BLOCK_REASONS_PREFIX = 'mta:ip-pool:block-reasons:';

export type IpPoolBlockReason = 'dnsbl' | 'fcrdns';

// Atomically compose independent exclusion reasons. Clearing one subsystem's
// reason must never reactivate an IP that another subsystem still quarantines.
const SET_BLOCK_REASON_SCRIPT = `
local reasonKey = KEYS[1]
local activeKey = KEYS[2]
local ip = ARGV[1]
local reason = ARGV[2]
local blocked = ARGV[3]

if blocked == '1' then
  redis.call('HSET', reasonKey, reason, '1')
  redis.call('SREM', activeKey, ip)
  return 0
end

redis.call('HDEL', reasonKey, reason)
if redis.call('HLEN', reasonKey) == 0 then
  redis.call('DEL', reasonKey)
  redis.call('SADD', activeKey, ip)
  return 1
end
redis.call('SREM', activeKey, ip)
return 0
`;

/**
 * Add or clear one independent eligibility block and return whether the IP is
 * active afterwards. The Lua transaction prevents DNSBL/FCrDNS races from
 * losing a reason between the hash update and active-set reconciliation.
 */
export async function setIpPoolBlock(
	redis: Redis,
	ip: string,
	reason: IpPoolBlockReason,
	blocked: boolean
): Promise<boolean> {
	const result = await redis.eval(
		SET_BLOCK_REASON_SCRIPT,
		2,
		`${BLOCK_REASONS_PREFIX}${ip}`,
		IP_POOL_ACTIVE,
		ip,
		reason,
		blocked ? '1' : '0'
	);
	return Number(result) === 1;
}

export async function getIpPoolBlockReasons(
	redis: Redis,
	ip: string
): Promise<IpPoolBlockReason[]> {
	const reasons = await redis.hkeys(`${BLOCK_REASONS_PREFIX}${ip}`);
	return reasons.filter(
		(reason): reason is IpPoolBlockReason => reason === 'dnsbl' || reason === 'fcrdns'
	);
}

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
	// A dedicated route is an identity constraint, not a preference. Falling
	// through to another IP would silently violate the configured routing rule.
	if (dedicatedIp) {
		const activeIps = await redis.smembers(IP_POOL_ACTIVE);
		if (activeIps.includes(dedicatedIp)) return dedicatedIp;
		logger.error({ dedicatedIp }, 'Dedicated IP is unavailable; delivery remains queued');
		return null;
	}

	const poolIps = config[pool];
	if (poolIps.length === 0) return null;

	// Get the set of currently active (non-blocked and non-quarantined) IPs.
	const activeIps = await redis.smembers(IP_POOL_ACTIVE);
	const activeSet = new Set(activeIps);

	// Filter pool IPs to only active ones
	const availableIps = poolIps.filter((ip) => activeSet.has(ip));

	if (availableIps.length === 0) {
		// A hard readiness gate must fail closed. Returning a configured but
		// quarantined address here would make the active set advisory and let a
		// fresh deployment send from a missing/mismatched PTR.
		logger.error({ pool }, 'No eligible IPs available for pool; delivery remains queued');
		return null;
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
export async function getPoolStatus(
	redis: Redis,
	config: IpPoolConfig
): Promise<
	Array<{
		ip: string;
		pool: IpPoolType;
		active: boolean;
		blockReasons: IpPoolBlockReason[];
	}>
> {
	const activeIps = await redis.smembers(IP_POOL_ACTIVE);
	const activeSet = new Set(activeIps);
	const result: Array<{
		ip: string;
		pool: IpPoolType;
		active: boolean;
		blockReasons: IpPoolBlockReason[];
	}> = [];

	for (const ip of config.transactional) {
		result.push({
			ip,
			pool: 'transactional',
			active: activeSet.has(ip),
			blockReasons: await getIpPoolBlockReasons(redis, ip),
		});
	}
	for (const ip of config.campaign) {
		result.push({
			ip,
			pool: 'campaign',
			active: activeSet.has(ip),
			blockReasons: await getIpPoolBlockReasons(redis, ip),
		});
	}

	return result;
}

/**
 * Initialize IP pools in Redis (called on startup)
 */
export async function initializePools(redis: Redis, config: IpPoolConfig): Promise<void> {
	const allIps = [...new Set([...config.transactional, ...config.campaign])];
	for (const ip of allIps) {
		// Reconcile persisted reasons on restart; never blindly re-add a previously
		// quarantined or blocklisted address.
		const reasons = await getIpPoolBlockReasons(redis, ip);
		if (reasons.length === 0) await redis.sadd(IP_POOL_ACTIVE, ip);
		else await redis.srem(IP_POOL_ACTIVE, ip);
	}
	logger.info(
		{ transactional: config.transactional, campaign: config.campaign },
		'IP pools initialized'
	);
}
