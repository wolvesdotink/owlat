/**
 * Dynamic ISP Profile Management
 *
 * Stores ISP sending profiles in Redis so they can be updated at runtime
 * without redeployment. Profiles define per-domain rate limits, backoff
 * factors, and recovery speeds for the adaptive domain throttling system.
 *
 * On startup, profiles from config.ts ISP_PROFILES are seeded into Redis
 * as defaults. Admin API can then override individual domains.
 */

import type Redis from 'ioredis';
import type { DomainProfile } from '../types.js';
import { ISP_PROFILES } from '../config.js';
import { logger } from '../monitoring/logger.js';

const PROFILE_PREFIX = 'mta:isp-profile:';
const PROFILE_LIST_KEY = 'mta:isp-profiles';

/**
 * Seed default ISP profiles into Redis (only sets keys that don't exist)
 * Called once during MTA startup
 */
export async function seedProfiles(redis: Redis): Promise<void> {
	const pipeline = redis.pipeline();
	const domains: string[] = [];

	for (const [domain, profile] of Object.entries(ISP_PROFILES)) {
		const key = `${PROFILE_PREFIX}${domain}`;
		// Use HSETNX to avoid overwriting runtime changes
		pipeline.hsetnx(key, 'defaultRate', String(profile.defaultRate));
		pipeline.hsetnx(key, 'ceiling', String(profile.ceiling));
		pipeline.hsetnx(key, 'floor', String(profile.floor));
		pipeline.hsetnx(key, 'backoffFactor', String(profile.backoffFactor));
		pipeline.hsetnx(key, 'recoveryFactor', String(profile.recoveryFactor));
		domains.push(domain);
	}

	// Track all known domains
	for (const domain of domains) {
		pipeline.sadd(PROFILE_LIST_KEY, domain);
	}

	await pipeline.exec();
	logger.info({ count: domains.length }, 'ISP profiles seeded');
}

/**
 * Get an ISP profile for a domain (from Redis, with fallback to hardcoded default)
 */
export async function getProfile(redis: Redis, domain: string): Promise<DomainProfile> {
	const key = `${PROFILE_PREFIX}${domain.toLowerCase()}`;
	const data = await redis.hgetall(key);

	if (data['defaultRate']) {
		return {
			defaultRate: parseFloat(data['defaultRate']),
			ceiling: parseFloat(data['ceiling'] ?? ''),
			floor: parseFloat(data['floor'] ?? ''),
			backoffFactor: parseFloat(data['backoffFactor'] ?? ''),
			recoveryFactor: parseFloat(data['recoveryFactor'] ?? ''),
		};
	}

	// Fall back to hardcoded default profile
	const defaultKey = `${PROFILE_PREFIX}__default__`;
	const defaultData = await redis.hgetall(defaultKey);

	if (defaultData['defaultRate']) {
		return {
			defaultRate: parseFloat(defaultData['defaultRate']),
			ceiling: parseFloat(defaultData['ceiling'] ?? ''),
			floor: parseFloat(defaultData['floor'] ?? ''),
			backoffFactor: parseFloat(defaultData['backoffFactor'] ?? ''),
			recoveryFactor: parseFloat(defaultData['recoveryFactor'] ?? ''),
		};
	}

	// Ultimate fallback to hardcoded ISP_PROFILES
	return ISP_PROFILES[domain.toLowerCase()] ?? ISP_PROFILES['__default__']!;
}

/**
 * Update or create an ISP profile for a domain
 */
export async function setProfile(
	redis: Redis,
	domain: string,
	profile: Partial<DomainProfile>
): Promise<DomainProfile> {
	const key = `${PROFILE_PREFIX}${domain.toLowerCase()}`;

	// Get existing profile to merge with
	const existing = await getProfile(redis, domain);
	const merged: DomainProfile = {
		defaultRate: profile.defaultRate ?? existing.defaultRate,
		ceiling: profile.ceiling ?? existing.ceiling,
		floor: profile.floor ?? existing.floor,
		backoffFactor: profile.backoffFactor ?? existing.backoffFactor,
		recoveryFactor: profile.recoveryFactor ?? existing.recoveryFactor,
	};

	// Validate constraints
	if (merged.floor > merged.ceiling) {
		throw new Error('floor must be <= ceiling');
	}
	if (merged.defaultRate < merged.floor || merged.defaultRate > merged.ceiling) {
		throw new Error('defaultRate must be between floor and ceiling');
	}
	if (merged.backoffFactor <= 0 || merged.backoffFactor >= 1) {
		throw new Error('backoffFactor must be between 0 and 1 (exclusive)');
	}
	if (merged.recoveryFactor <= 1) {
		throw new Error('recoveryFactor must be > 1');
	}

	await redis.hset(
		key,
		'defaultRate', String(merged.defaultRate),
		'ceiling', String(merged.ceiling),
		'floor', String(merged.floor),
		'backoffFactor', String(merged.backoffFactor),
		'recoveryFactor', String(merged.recoveryFactor)
	);
	await redis.sadd(PROFILE_LIST_KEY, domain.toLowerCase());

	logger.info({ domain, profile: merged }, 'ISP profile updated');
	return merged;
}

/**
 * Delete a custom ISP profile (reverts to hardcoded default)
 */
export async function deleteProfile(redis: Redis, domain: string): Promise<boolean> {
	const key = `${PROFILE_PREFIX}${domain.toLowerCase()}`;
	const deleted = await redis.del(key);
	await redis.srem(PROFILE_LIST_KEY, domain.toLowerCase());
	return deleted > 0;
}

/**
 * List all ISP profiles (both custom and seeded)
 */
export async function listProfiles(redis: Redis): Promise<Record<string, DomainProfile>> {
	const domains = await redis.smembers(PROFILE_LIST_KEY);
	const result: Record<string, DomainProfile> = {};

	for (const domain of domains) {
		result[domain] = await getProfile(redis, domain);
	}

	return result;
}
