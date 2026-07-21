/**
 * Dynamic ISP Profile Management
 *
 * Stores ISP sending profiles in Redis so they can be updated at runtime
 * without redeployment. Profiles define per-domain rate limits, backoff
 * factors, TLS floors, and connection shaping for destination providers.
 *
 * On startup, checked-in destination-provider profiles are seeded into Redis
 * as defaults. Admin API can then override individual domains.
 */

import type Redis from 'ioredis';
import { isOutboundTlsMode } from '@owlat/shared';
import type { DestinationProviderProfile } from '../types.js';
import { DESTINATION_PROVIDER_PROFILES } from '../config.js';
import { logger } from '../monitoring/logger.js';

const PROFILE_PREFIX = 'mta:isp-profile:';
const PROFILE_LIST_KEY = 'mta:isp-profiles';

function canonicalProfileKey(value: string): string {
	const key = value.toLowerCase();
	if (key === 'gmail.com' || key === 'googlemail.com') return 'gmail';
	if (key === 'outlook.com' || key === 'hotmail.com' || key === 'live.com' || key === 'msn.com') {
		return 'microsoft';
	}
	if (key === 'yahoo.com' || key === 'aol.com' || key === 'ymail.com' || key === 'yahoo.co.uk') {
		return 'yahoo';
	}
	if (key === 'icloud.com' || key === 'me.com' || key === 'mac.com') return 'apple';
	return key;
}

/**
 * Seed default ISP profiles into Redis (only sets keys that don't exist)
 * Called once during MTA startup
 */
export async function seedProfiles(redis: Redis): Promise<void> {
	const pipeline = redis.pipeline();
	const providerKeys: string[] = [];

	for (const [providerKey, profile] of Object.entries(DESTINATION_PROVIDER_PROFILES)) {
		const key = `${PROFILE_PREFIX}${providerKey}`;
		// Use HSETNX to avoid overwriting runtime changes
		pipeline.hsetnx(key, 'defaultRate', String(profile.defaultRate));
		pipeline.hsetnx(key, 'ceiling', String(profile.ceiling));
		pipeline.hsetnx(key, 'floor', String(profile.floor));
		pipeline.hsetnx(key, 'backoffFactor', String(profile.backoffFactor));
		pipeline.hsetnx(key, 'recoveryFactor', String(profile.recoveryFactor));
		pipeline.hsetnx(key, 'tlsMode', profile.tlsMode);
		pipeline.hsetnx(key, 'maxConnections', String(profile.maxConnections));
		pipeline.hsetnx(key, 'maxDeliveriesPerConnection', String(profile.maxDeliveriesPerConnection));
		providerKeys.push(providerKey);
	}

	// Track all known domains
	for (const providerKey of providerKeys) {
		pipeline.sadd(PROFILE_LIST_KEY, providerKey);
	}

	await pipeline.exec();
	logger.info({ count: providerKeys.length }, 'Destination provider profiles seeded');
}

/**
 * Get a destination-provider profile with a hardcoded safe fallback.
 */
export async function getProfile(
	redis: Redis,
	providerKey: string
): Promise<DestinationProviderProfile> {
	const canonicalKey = canonicalProfileKey(providerKey);
	const key = `${PROFILE_PREFIX}${canonicalKey}`;
	const data = await redis.hgetall(key);

	if (data['defaultRate']) {
		return parseProfile(
			data,
			DESTINATION_PROVIDER_PROFILES[canonicalKey] ?? DESTINATION_PROVIDER_PROFILES['__default__']!
		);
	}

	// Fall back to hardcoded default profile
	const defaultKey = `${PROFILE_PREFIX}__default__`;
	const defaultData = await redis.hgetall(defaultKey);

	if (defaultData['defaultRate']) {
		return parseProfile(defaultData, DESTINATION_PROVIDER_PROFILES['__default__']!);
	}

	// Ultimate fallback to the checked-in provider defaults.
	return (
		DESTINATION_PROVIDER_PROFILES[canonicalKey] ?? DESTINATION_PROVIDER_PROFILES['__default__']!
	);
}

function parseProfile(
	data: Record<string, string>,
	fallback: DestinationProviderProfile
): DestinationProviderProfile {
	const tlsMode = data['tlsMode'];
	return {
		defaultRate: parseFloat(data['defaultRate'] ?? String(fallback.defaultRate)),
		ceiling: parseFloat(data['ceiling'] ?? String(fallback.ceiling)),
		floor: parseFloat(data['floor'] ?? String(fallback.floor)),
		backoffFactor: parseFloat(data['backoffFactor'] ?? String(fallback.backoffFactor)),
		recoveryFactor: parseFloat(data['recoveryFactor'] ?? String(fallback.recoveryFactor)),
		tlsMode: tlsMode !== undefined && isOutboundTlsMode(tlsMode) ? tlsMode : fallback.tlsMode,
		maxConnections: parseInt(data['maxConnections'] ?? String(fallback.maxConnections), 10),
		maxDeliveriesPerConnection: parseInt(
			data['maxDeliveriesPerConnection'] ?? String(fallback.maxDeliveriesPerConnection),
			10
		),
	};
}

/**
 * Update or create a destination-provider profile.
 */
export async function setProfile(
	redis: Redis,
	providerKey: string,
	profile: Partial<DestinationProviderProfile>
): Promise<DestinationProviderProfile> {
	const canonicalKey = canonicalProfileKey(providerKey);
	const key = `${PROFILE_PREFIX}${canonicalKey}`;

	// Get existing profile to merge with
	const existing = await getProfile(redis, providerKey);
	const merged: DestinationProviderProfile = {
		defaultRate: profile.defaultRate ?? existing.defaultRate,
		ceiling: profile.ceiling ?? existing.ceiling,
		floor: profile.floor ?? existing.floor,
		backoffFactor: profile.backoffFactor ?? existing.backoffFactor,
		recoveryFactor: profile.recoveryFactor ?? existing.recoveryFactor,
		tlsMode: profile.tlsMode ?? existing.tlsMode,
		maxConnections: profile.maxConnections ?? existing.maxConnections,
		maxDeliveriesPerConnection:
			profile.maxDeliveriesPerConnection ?? existing.maxDeliveriesPerConnection,
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
	if (
		!Number.isSafeInteger(merged.maxConnections) ||
		merged.maxConnections < 1 ||
		merged.maxConnections > 100
	) {
		throw new Error('maxConnections must be an integer between 1 and 100');
	}
	if (
		!Number.isSafeInteger(merged.maxDeliveriesPerConnection) ||
		merged.maxDeliveriesPerConnection < 1 ||
		merged.maxDeliveriesPerConnection > 10_000
	) {
		throw new Error('maxDeliveriesPerConnection must be an integer between 1 and 10000');
	}

	await redis.hset(
		key,
		'defaultRate',
		String(merged.defaultRate),
		'ceiling',
		String(merged.ceiling),
		'floor',
		String(merged.floor),
		'backoffFactor',
		String(merged.backoffFactor),
		'recoveryFactor',
		String(merged.recoveryFactor),
		'tlsMode',
		merged.tlsMode,
		'maxConnections',
		String(merged.maxConnections),
		'maxDeliveriesPerConnection',
		String(merged.maxDeliveriesPerConnection)
	);
	await redis.sadd(PROFILE_LIST_KEY, canonicalKey);

	logger.info({ providerKey, profile: merged }, 'Destination provider profile updated');
	return merged;
}

/**
 * Delete a custom ISP profile (reverts to hardcoded default)
 */
export async function deleteProfile(redis: Redis, providerKey: string): Promise<boolean> {
	const canonicalKey = canonicalProfileKey(providerKey);
	const key = `${PROFILE_PREFIX}${canonicalKey}`;
	const deleted = await redis.del(key);
	await redis.srem(PROFILE_LIST_KEY, canonicalKey);
	return deleted > 0;
}

/**
 * List all destination-provider profiles (both custom and seeded).
 */
export async function listProfiles(
	redis: Redis
): Promise<Record<string, DestinationProviderProfile>> {
	const providerKeys = await redis.smembers(PROFILE_LIST_KEY);
	const result: Record<string, DestinationProviderProfile> = {};

	for (const providerKey of providerKeys) {
		result[providerKey] = await getProfile(redis, providerKey);
	}

	return result;
}
