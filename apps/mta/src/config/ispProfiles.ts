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
import { isOutboundTlsMode, strictestOutboundTlsMode } from '@owlat/shared';
import {
	destinationProviderForDomain,
	isDestinationProviderKey,
	type DestinationProviderKey,
} from '@owlat/shared/deliverabilityRouting';
import type { DestinationProviderProfile } from '../types.js';
import { DESTINATION_PROVIDER_PROFILES } from '../config.js';
import { logger } from '../monitoring/logger.js';

const PROFILE_PREFIX = 'mta:isp-profile:';
const PROFILE_LIST_KEY = 'mta:isp-profiles';
const MAX_RATE_PER_MINUTE = 1_000_000;
const MAX_RECOVERY_FACTOR = 100;

/**
 * PINNED DIVERGENCE (D8) — profile-key selection is NOT the taxonomy.
 *
 * `destinationProviderForDomain` answers "which cell of the destination-provider
 * taxonomy is this RECIPIENT DOMAIN in?", and every unrecognised domain is
 * `other` by design: the cell axis is a fixed, bounded set that the ramp's
 * matrix, the warming dimensions and the ISP metric labels are all keyed by.
 *
 * This function answers a different question — "which Redis row shapes the
 * connection to this destination?" — and its input is a PROFILE KEY OR A RAW
 * DOMAIN, because that is what its callers hold: `acquireSlot`, `recordSuccess`
 * and `recordDefer` default `providerKey` to the `throttleKey` computed in
 * `smtp/destinationProvider.ts`, which is deliberately the DOMAIN for operators
 * outside the taxonomy ("known providers share a budget; unknown operators
 * remain domain scoped"). Folding those into `other` would merge every unknown
 * operator into one shaping row and silently retarget the Redis key each read
 * and write uses — a live behaviour change, not a cleanup. It also has to accept
 * a bare provider key (`getProfile(redis, 'gmail')` from the admin route and the
 * sender), which is not a domain at all and which the shared classifier would
 * correctly answer `other` for.
 *
 * So the two mappers stay, and the ALIAS TABLE — the part that could drift —
 * does not: the domain→provider folding is delegated to the shared classifier,
 * and the only thing left here is the unknown-input branch. The suite
 * `__tests__/destinationTaxonomy.test.ts` pins exactly that: agreement on every
 * domain the taxonomy names, and the domain-scoped passthrough everywhere else.
 */
export function canonicalProfileKey(value: string): string {
	const provider = destinationProviderForDomain(value);
	return provider === 'other' ? value.toLowerCase() : provider;
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
		if (isDestinationProviderKey(providerKey)) providerKeys.push(providerKey);
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
	const checkedInProfile = DESTINATION_PROVIDER_PROFILES[canonicalKey];
	const fallback = checkedInProfile ?? DESTINATION_PROVIDER_PROFILES['__default__']!;

	if (data['defaultRate']) {
		return applyProviderMinimum(canonicalKey, parseProfile(data, fallback));
	}

	// A deleted or absent known-provider override reverts immediately to that
	// provider's checked-in shaping policy. The generic Redis default is only for
	// `other` and genuinely unknown provider keys.
	if (checkedInProfile) return checkedInProfile;

	const defaultKey = `${PROFILE_PREFIX}__default__`;
	const defaultData = await redis.hgetall(defaultKey);

	if (defaultData['defaultRate']) {
		return applyProviderMinimum(
			canonicalKey,
			parseProfile(defaultData, DESTINATION_PROVIDER_PROFILES['__default__']!)
		);
	}

	// Ultimate fallback to the checked-in provider defaults.
	return (
		DESTINATION_PROVIDER_PROFILES[canonicalKey] ?? DESTINATION_PROVIDER_PROFILES['__default__']!
	);
}

function applyProviderMinimum(
	providerKey: string,
	profile: DestinationProviderProfile
): DestinationProviderProfile {
	const minimum = DESTINATION_PROVIDER_PROFILES[providerKey];
	if (!minimum) return profile;
	const tlsMode = strictestOutboundTlsMode(profile.tlsMode, minimum.tlsMode);
	if (tlsMode === profile.tlsMode) return profile;
	logger.warn(
		{ providerKey, configuredTlsMode: profile.tlsMode, minimumTlsMode: minimum.tlsMode },
		'Raising destination provider TLS mode to the checked-in minimum'
	);
	return { ...profile, tlsMode };
}

function parseProfile(
	data: Record<string, string>,
	fallback: DestinationProviderProfile
): DestinationProviderProfile {
	const tlsMode = data['tlsMode'];
	const parsed: DestinationProviderProfile = {
		defaultRate: Number(data['defaultRate'] ?? fallback.defaultRate),
		ceiling: Number(data['ceiling'] ?? fallback.ceiling),
		floor: Number(data['floor'] ?? fallback.floor),
		backoffFactor: Number(data['backoffFactor'] ?? fallback.backoffFactor),
		recoveryFactor: Number(data['recoveryFactor'] ?? fallback.recoveryFactor),
		tlsMode: tlsMode !== undefined && isOutboundTlsMode(tlsMode) ? tlsMode : fallback.tlsMode,
		maxConnections: Number(data['maxConnections'] ?? fallback.maxConnections),
		maxDeliveriesPerConnection: Number(
			data['maxDeliveriesPerConnection'] ?? fallback.maxDeliveriesPerConnection
		),
	};
	try {
		if (tlsMode !== undefined && !isOutboundTlsMode(tlsMode)) {
			throw new Error('tlsMode is invalid');
		}
		validateProfile(parsed);
		return parsed;
	} catch (err) {
		logger.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			'Ignoring corrupt destination provider profile in Redis'
		);
		return { ...fallback };
	}
}

function validateProfile(profile: DestinationProviderProfile, providerKey?: string): void {
	for (const [field, value] of [
		['defaultRate', profile.defaultRate],
		['ceiling', profile.ceiling],
		['floor', profile.floor],
	] as const) {
		if (!Number.isFinite(value) || value <= 0 || value > MAX_RATE_PER_MINUTE) {
			throw new Error(
				`${field} must be finite and between 0 (exclusive) and ${MAX_RATE_PER_MINUTE}`
			);
		}
	}
	if (profile.floor > profile.ceiling) {
		throw new Error('floor must be <= ceiling');
	}
	if (profile.defaultRate < profile.floor || profile.defaultRate > profile.ceiling) {
		throw new Error('defaultRate must be between floor and ceiling');
	}
	if (
		!Number.isFinite(profile.backoffFactor) ||
		profile.backoffFactor <= 0 ||
		profile.backoffFactor >= 1
	) {
		throw new Error('backoffFactor must be finite and between 0 and 1 (exclusive)');
	}
	if (
		!Number.isFinite(profile.recoveryFactor) ||
		profile.recoveryFactor <= 1 ||
		profile.recoveryFactor > MAX_RECOVERY_FACTOR
	) {
		throw new Error(
			`recoveryFactor must be finite and between 1 (exclusive) and ${MAX_RECOVERY_FACTOR}`
		);
	}
	if (
		!Number.isSafeInteger(profile.maxConnections) ||
		profile.maxConnections < 1 ||
		profile.maxConnections > 100
	) {
		throw new Error('maxConnections must be an integer between 1 and 100');
	}
	if (
		!Number.isSafeInteger(profile.maxDeliveriesPerConnection) ||
		profile.maxDeliveriesPerConnection < 1 ||
		profile.maxDeliveriesPerConnection > 10_000
	) {
		throw new Error('maxDeliveriesPerConnection must be an integer between 1 and 10000');
	}
	const minimumTlsMode = providerKey
		? DESTINATION_PROVIDER_PROFILES[providerKey]?.tlsMode
		: undefined;
	if (
		minimumTlsMode &&
		strictestOutboundTlsMode(profile.tlsMode, minimumTlsMode) !== profile.tlsMode
	) {
		throw new Error(
			`${providerKey} tlsMode cannot be below the checked-in ${minimumTlsMode} minimum`
		);
	}
}

/**
 * Update or create a destination-provider profile.
 */
export async function setProfile(
	redis: Redis,
	providerKey: DestinationProviderKey,
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

	validateProfile(merged, canonicalKey);

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
export async function deleteProfile(
	redis: Redis,
	providerKey: DestinationProviderKey
): Promise<boolean> {
	const canonicalKey = canonicalProfileKey(providerKey);
	const key = `${PROFILE_PREFIX}${canonicalKey}`;
	const deleted = await redis.del(key);
	// DELETE removes only the runtime override. The known provider remains in the
	// catalog so list callers immediately see its effective checked-in defaults.
	await redis.sadd(PROFILE_LIST_KEY, canonicalKey);
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
		if (isDestinationProviderKey(providerKey)) {
			result[providerKey] = await getProfile(redis, providerKey);
		}
	}

	return result;
}
