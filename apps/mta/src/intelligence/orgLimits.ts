/**
 * Per-Organization Send Rate Limits
 *
 * Enforces daily and hourly send caps per organization to prevent
 * any single org from monopolizing sending capacity.
 */

import type Redis from 'ioredis';
import { logger } from '../monitoring/logger.js';

const DAILY_PREFIX = 'mta:org-limit:daily:';
const HOURLY_PREFIX = 'mta:org-limit:hourly:';
const CONFIG_PREFIX = 'mta:org-config:';

interface OrgLimitConfig {
	dailyLimit: number;
	hourlyLimit: number;
}

interface LimitCheckResult {
	allowed: boolean;
	retryAfter?: number;
	dailySent?: number;
	hourlySent?: number;
	dailyLimit?: number;
	hourlyLimit?: number;
}

// Default limits from config
let defaultDailyLimit = 50_000;
let defaultHourlyLimit = 5_000;

export function setDefaults(daily: number, hourly: number): void {
	defaultDailyLimit = daily;
	defaultHourlyLimit = hourly;
}

/**
 * Check if org is within rate limits and increment counters
 */
export async function checkAndIncrement(redis: Redis, orgId: string): Promise<LimitCheckResult> {
	const now = new Date();
	const dateKey = now.toISOString().split('T')[0]; // YYYY-MM-DD
	const hourKey = `${dateKey}:${now.getUTCHours()}`; // YYYY-MM-DD:HH

	const dailyKey = `${DAILY_PREFIX}${orgId}:${dateKey}`;
	const hourlyKey = `${HOURLY_PREFIX}${orgId}:${hourKey}`;

	// Get org-specific limits (or use defaults)
	const limits = await getOrgLimits(redis, orgId);

	// Check current counts
	const [dailyCount, hourlyCount] = await Promise.all([
		redis.get(dailyKey),
		redis.get(hourlyKey),
	]);

	const dailySent = parseInt(dailyCount ?? '0', 10);
	const hourlySent = parseInt(hourlyCount ?? '0', 10);

	// Check daily limit
	if (dailySent >= limits.dailyLimit) {
		// Retry after midnight UTC
		const tomorrow = new Date(now);
		tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
		tomorrow.setUTCHours(0, 0, 0, 0);
		const retryAfter = tomorrow.getTime() - now.getTime();

		logger.warn({ orgId, dailySent, dailyLimit: limits.dailyLimit }, 'Org daily limit reached');
		return { allowed: false, retryAfter, dailySent, hourlySent, dailyLimit: limits.dailyLimit, hourlyLimit: limits.hourlyLimit };
	}

	// Check hourly limit
	if (hourlySent >= limits.hourlyLimit) {
		// Retry after next hour
		const nextHour = new Date(now);
		nextHour.setUTCHours(nextHour.getUTCHours() + 1, 0, 0, 0);
		const retryAfter = nextHour.getTime() - now.getTime();

		logger.warn({ orgId, hourlySent, hourlyLimit: limits.hourlyLimit }, 'Org hourly limit reached');
		return { allowed: false, retryAfter, hourlySent, dailySent, dailyLimit: limits.dailyLimit, hourlyLimit: limits.hourlyLimit };
	}

	// Increment both counters
	const pipeline = redis.pipeline();
	pipeline.incr(dailyKey);
	pipeline.expire(dailyKey, 172800); // 48h TTL
	pipeline.incr(hourlyKey);
	pipeline.expire(hourlyKey, 7200); // 2h TTL
	await pipeline.exec();

	return { allowed: true, dailySent: dailySent + 1, hourlySent: hourlySent + 1, dailyLimit: limits.dailyLimit, hourlyLimit: limits.hourlyLimit };
}

/**
 * Get org-specific limits or defaults
 */
async function getOrgLimits(redis: Redis, orgId: string): Promise<OrgLimitConfig> {
	const config = await redis.hgetall(`${CONFIG_PREFIX}${orgId}`);
	return {
		dailyLimit: config['dailyLimit'] ? parseInt(config['dailyLimit'], 10) : defaultDailyLimit,
		hourlyLimit: config['hourlyLimit'] ? parseInt(config['hourlyLimit'], 10) : defaultHourlyLimit,
	};
}

/**
 * Set org-specific rate limits (0 = use default)
 */
export async function setOrgLimits(
	redis: Redis,
	orgId: string,
	dailyLimit?: number,
	hourlyLimit?: number
): Promise<void> {
	const key = `${CONFIG_PREFIX}${orgId}`;
	if (dailyLimit !== undefined) await redis.hset(key, 'dailyLimit', String(dailyLimit));
	if (hourlyLimit !== undefined) await redis.hset(key, 'hourlyLimit', String(hourlyLimit));
	logger.info({ orgId, dailyLimit, hourlyLimit }, 'Org rate limits updated');
}

/**
 * Get current usage for an org
 */
export async function getOrgUsage(redis: Redis, orgId: string): Promise<{
	dailySent: number;
	hourlySent: number;
	limits: OrgLimitConfig;
}> {
	const now = new Date();
	const dateKey = now.toISOString().split('T')[0];
	const hourKey = `${dateKey}:${now.getUTCHours()}`;

	const [dailyCount, hourlyCount] = await Promise.all([
		redis.get(`${DAILY_PREFIX}${orgId}:${dateKey}`),
		redis.get(`${HOURLY_PREFIX}${orgId}:${hourKey}`),
	]);

	return {
		dailySent: parseInt(dailyCount ?? '0', 10),
		hourlySent: parseInt(hourlyCount ?? '0', 10),
		limits: await getOrgLimits(redis, orgId),
	};
}
