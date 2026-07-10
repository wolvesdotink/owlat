/**
 * [1] Adaptive Per-IP Per-Domain Rate Throttling
 *
 * Self-regulates sending rate per source IP + recipient domain based on SMTP
 * responses. Each IP maintains its own adaptive rate for each domain, matching
 * how ISPs evaluate sender reputation (per source IP, not per MTA instance).
 *
 * When ISPs return 4xx "too many connections", the rate automatically drops.
 * On sustained success, it gradually recovers toward the ceiling.
 *
 * Uses a sliding window in Redis to count recent sends per IP+domain,
 * and a hash to track the current adaptive rate.
 */

import type Redis from 'ioredis';
// Reads the runtime profile from Redis (seeded from config.ts ISP_PROFILES on
// startup, then overridable via the admin API) so that operator changes — e.g.
// lowering gmail.com's rate during a deliverability incident — take effect on
// the throttle hot path without a redeploy. Falls back to the hardcoded
// defaults when Redis has no profile (e.g. before seeding).
import { getProfile } from '../config/ispProfiles.js';
import { logger } from '../monitoring/logger.js';

const THROTTLE_PREFIX = 'mta:throttle:';
const WINDOW_PREFIX = 'mta:throttle:window:';
const WINDOW_SECONDS = 60;
const RECOVERY_THRESHOLD = 20; // consecutive successes before rate increase
const HASH_TTL = 86400; // 24h TTL for throttle state

/**
 * Build Redis keys scoped to a specific IP + domain pair
 */
function keys(ip: string, domain: string) {
	return {
		hash: `${THROTTLE_PREFIX}${ip}:${domain}`,
		window: `${WINDOW_PREFIX}${ip}:${domain}`,
	};
}

/**
 * Lua script for atomic slot acquisition.
 *
 * Performs the full check-and-increment in a single Redis command to prevent
 * race conditions where multiple workers could exceed the rate ceiling by
 * checking the count before any of them add their entries.
 *
 * KEYS[1] = hash key (throttle state)
 * KEYS[2] = window key (sorted set of send timestamps)
 * KEYS[3] = sequence key (monotonic counter for unique window members)
 * ARGV[1] = current timestamp (ms)
 * ARGV[2] = window start timestamp (ms)
 * ARGV[3] = default rate from ISP profile
 * ARGV[4] = hash TTL in seconds
 * ARGV[5] = window TTL in seconds
 *
 * Returns: 1 if slot acquired, 0 if denied
 */
const ACQUIRE_SLOT_LUA = `
local hashKey = KEYS[1]
local windowKey = KEYS[2]
local seqKey = KEYS[3]
local now = ARGV[1]
local windowStart = ARGV[2]
local defaultRate = tonumber(ARGV[3])
local hashTtl = tonumber(ARGV[4])
local windowTtl = tonumber(ARGV[5])

-- Get or initialize current rate
local currentRate = tonumber(redis.call('HGET', hashKey, 'currentRate'))
if not currentRate then
  currentRate = defaultRate
  redis.call('HSET', hashKey, 'currentRate', tostring(currentRate), 'status', 'healthy')
  redis.call('EXPIRE', hashKey, hashTtl)
end

-- Check blocking status with automatic recovery
local status = redis.call('HGET', hashKey, 'status')
if status == 'blocking' then
  local lastDeferAt = tonumber(redis.call('HGET', hashKey, 'lastDeferAt') or '0')
  if tonumber(now) - lastDeferAt > 3600000 then
    -- 1 hour without activity: auto-recover to healthy (prevents permanently stuck state)
    redis.call('HSET', hashKey, 'status', 'healthy', 'recentDefers', '0', 'consecutiveSuccess', '0')
  elseif tonumber(now) - lastDeferAt > 300000 then
    -- 5 minutes: transition to degraded (existing behavior)
    redis.call('HSET', hashKey, 'status', 'degraded')
  else
    return 0
  end
end

-- Clean expired entries and count window atomically
redis.call('ZREMRANGEBYSCORE', windowKey, '-inf', windowStart)
local windowCount = redis.call('ZCARD', windowKey)

if windowCount >= currentRate then
  return 0
end

-- Acquire the slot atomically. Use a monotonic per-window sequence for the
-- sorted-set member so it is ALWAYS unique — never a random suffix, which can
-- collide (birthday) when many acquisitions share the same 'now', causing the
-- ZADD to overwrite an existing member instead of adding a row, undercounting
-- the window and admitting one slot over the cap.
local seq = redis.call('INCR', seqKey)
redis.call('EXPIRE', seqKey, windowTtl)
redis.call('ZADD', windowKey, now, now .. ':' .. tostring(seq))
redis.call('EXPIRE', windowKey, windowTtl)

return 1
`;

/**
 * Try to acquire a sending slot for an IP+domain pair.
 * Returns true if sending is allowed, false if rate limit exceeded.
 *
 * Uses a Lua script for atomic check-and-increment to prevent race
 * conditions when multiple workers compete for the same IP+domain pair.
 */
export async function acquireSlot(redis: Redis, ip: string, domain: string): Promise<boolean> {
	const profile = await getProfile(redis, domain);
	const { hash: hashKey, window: windowKey } = keys(ip, domain);
	const now = Date.now();
	const windowStart = now - WINDOW_SECONDS * 1000;

	const result = await redis.eval(
		ACQUIRE_SLOT_LUA,
		3,
		hashKey,
		windowKey,
		`${windowKey}:seq`,
		String(now),
		String(windowStart),
		String(profile.defaultRate),
		String(HASH_TTL),
		String(WINDOW_SECONDS + 10)
	);

	return result === 1;
}

/**
 * Record a successful send — may increase rate on sustained success
 */
export async function recordSuccess(redis: Redis, ip: string, domain: string): Promise<void> {
	const profile = await getProfile(redis, domain);
	const { hash: hashKey } = keys(ip, domain);

	const consecutive = await redis.hincrby(hashKey, 'consecutiveSuccess', 1);

	// Recovery: after sustained success, increase rate toward ceiling
	if (consecutive >= RECOVERY_THRESHOLD) {
		const currentRate = parseFloat(
			(await redis.hget(hashKey, 'currentRate')) ?? String(profile.defaultRate)
		);
		const newRate = Math.min(currentRate * profile.recoveryFactor, profile.ceiling);

		await redis.hset(
			hashKey,
			'currentRate',
			String(newRate),
			'consecutiveSuccess',
			'0',
			'status',
			'healthy'
		);

		if (newRate > currentRate) {
			logger.debug({ ip, domain, currentRate, newRate }, 'Domain throttle rate increased');
		}
	}

	await redis.expire(hashKey, HASH_TTL);
}

/**
 * Record a deferral (4xx) — reduces rate and marks domain as degraded
 */
export async function recordDefer(redis: Redis, ip: string, domain: string): Promise<void> {
	const profile = await getProfile(redis, domain);
	const { hash: hashKey } = keys(ip, domain);
	const now = Date.now();

	const currentRate = parseFloat(
		(await redis.hget(hashKey, 'currentRate')) ?? String(profile.defaultRate)
	);
	const newRate = Math.max(currentRate * profile.backoffFactor, profile.floor);

	// Check for rapid deferrals → blocking status
	const lastDeferAt = parseInt((await redis.hget(hashKey, 'lastDeferAt')) ?? '0', 10);
	const recentDefers = parseInt((await redis.hget(hashKey, 'recentDefers')) ?? '0', 10);

	let status = 'degraded';
	let newRecentDefers = recentDefers;

	if (now - lastDeferAt < 300_000) {
		// Within 5 minutes of last defer
		newRecentDefers++;
		if (newRecentDefers >= 3) {
			status = 'blocking';
			logger.warn(
				{ ip, domain, recentDefers: newRecentDefers },
				'Domain marked as blocking for IP'
			);
		}
	} else {
		newRecentDefers = 1;
	}

	await redis.hset(
		hashKey,
		'currentRate',
		String(newRate),
		'consecutiveSuccess',
		'0',
		'lastDeferAt',
		String(now),
		'status',
		status,
		'recentDefers',
		String(newRecentDefers)
	);
	await redis.expire(hashKey, HASH_TTL);

	logger.info(
		{ ip, domain, previousRate: currentRate, newRate, status },
		'Domain throttle rate reduced'
	);
}

/**
 * Record a permanent rejection (5xx) — contributes to blocking detection
 */
export async function recordReject(redis: Redis, ip: string, domain: string): Promise<void> {
	const { hash: hashKey } = keys(ip, domain);
	await redis.hset(hashKey, 'consecutiveSuccess', '0');
	await redis.expire(hashKey, HASH_TTL);
}

/**
 * Get current throttle state for an IP+domain pair (for monitoring)
 */
export async function getThrottleState(
	redis: Redis,
	ip: string,
	domain: string
): Promise<{
	currentRate: number;
	status: string;
	consecutiveSuccess: number;
} | null> {
	const { hash: hashKey } = keys(ip, domain);
	const data = await redis.hgetall(hashKey);
	if (!data['currentRate']) return null;

	return {
		currentRate: parseFloat(data['currentRate']),
		status: data['status'] ?? 'unknown',
		consecutiveSuccess: parseInt(data['consecutiveSuccess'] ?? '0', 10),
	};
}
