/**
 * IP Pool Routing Rules
 *
 * Configurable per-org pool assignment and dedicated IP support.
 * Rule precedence: explicit org rule → request ipPool field → default pool.
 */

import type Redis from 'ioredis';
import type { IpPoolType } from '../types.js';
import { logger } from '../monitoring/logger.js';

const POOL_RULES_PREFIX = 'mta:pool-rules:';

export interface PoolRule {
	/** Override pool assignment for this org */
	pool?: IpPoolType;
	/** Dedicated IP for this org (bypasses round-robin) */
	dedicatedIp?: string;
	/** Match sender domain (e.g., "notifications.example.com") */
	fromDomain?: string;
	/** Match recipient domain (e.g., "gmail.com") */
	toDomain?: string;
}

/**
 * Resolve the effective pool for a send request.
 *
 * Resolution priority:
 * 1. Org + fromDomain + toDomain match (most specific)
 * 2. Org + fromDomain match
 * 3. Org-level rule
 * 4. Request pool (default)
 */
export async function resolvePool(
	redis: Redis,
	orgId: string,
	requestedPool: IpPoolType,
	fromDomain?: string,
	toDomain?: string
): Promise<{ pool: IpPoolType; dedicatedIp?: string }> {
	// Try most specific first: org + fromDomain + toDomain
	if (fromDomain && toDomain) {
		const specificRule = await getRule(redis, orgId, fromDomain, toDomain);
		if (specificRule) {
			return {
				pool: specificRule.pool ?? requestedPool,
				dedicatedIp: specificRule.dedicatedIp,
			};
		}
	}

	// Try org + fromDomain
	if (fromDomain) {
		const fromRule = await getRule(redis, orgId, fromDomain);
		if (fromRule) {
			return {
				pool: fromRule.pool ?? requestedPool,
				dedicatedIp: fromRule.dedicatedIp,
			};
		}
	}

	// Try org-level rule
	const orgRule = await getRule(redis, orgId);
	if (orgRule) {
		return {
			pool: orgRule.pool ?? requestedPool,
			dedicatedIp: orgRule.dedicatedIp,
		};
	}

	return { pool: requestedPool };
}

/**
 * Build the Redis key for a pool rule
 */
function buildKey(orgId: string, fromDomain?: string, toDomain?: string): string {
	if (fromDomain && toDomain) return `${POOL_RULES_PREFIX}${orgId}:${fromDomain}:${toDomain}`;
	if (fromDomain) return `${POOL_RULES_PREFIX}${orgId}:${fromDomain}`;
	return `${POOL_RULES_PREFIX}${orgId}`;
}

/**
 * Get pool rule for an org (optionally scoped by domain)
 */
async function getRule(
	redis: Redis,
	orgId: string,
	fromDomain?: string,
	toDomain?: string
): Promise<PoolRule | null> {
	const key = buildKey(orgId, fromDomain, toDomain);
	const data = await redis.hgetall(key);
	if (!data || Object.keys(data).length === 0) return null;

	return {
		pool: data['pool'] as IpPoolType | undefined,
		dedicatedIp: data['dedicatedIp'] || undefined,
		fromDomain: data['fromDomain'] || undefined,
		toDomain: data['toDomain'] || undefined,
	};
}

/**
 * Set pool rule for an org
 */
export async function setRule(
	redis: Redis,
	orgId: string,
	rule: PoolRule
): Promise<void> {
	const key = buildKey(orgId, rule.fromDomain, rule.toDomain);
	const fields: Record<string, string> = {};
	if (rule.pool) fields['pool'] = rule.pool;
	if (rule.dedicatedIp) fields['dedicatedIp'] = rule.dedicatedIp;
	if (rule.fromDomain) fields['fromDomain'] = rule.fromDomain;
	if (rule.toDomain) fields['toDomain'] = rule.toDomain;

	if (Object.keys(fields).length > 0) {
		await redis.hmset(key, fields);
	}
	logger.info({ orgId, rule }, 'Pool rule updated');
}

/**
 * Remove pool rule for an org
 */
export async function removeRule(
	redis: Redis,
	orgId: string,
	fromDomain?: string,
	toDomain?: string
): Promise<boolean> {
	const key = buildKey(orgId, fromDomain, toDomain);
	const result = await redis.del(key);
	return result > 0;
}

/**
 * Get pool rule for display
 */
export async function getOrgRule(
	redis: Redis,
	orgId: string,
	fromDomain?: string,
	toDomain?: string
): Promise<PoolRule | null> {
	return getRule(redis, orgId, fromDomain, toDomain);
}

/**
 * List all pool rules for an org (including domain-scoped rules)
 */
export async function listOrgRules(redis: Redis, orgId: string): Promise<PoolRule[]> {
	const rules: PoolRule[] = [];

	// Scan for all keys matching this org
	const pattern = `${POOL_RULES_PREFIX}${orgId}*`;
	let cursor = '0';

	do {
		const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
		cursor = nextCursor;

		for (const key of keys) {
			const data = await redis.hgetall(key);
			if (data && Object.keys(data).length > 0) {
				rules.push({
					pool: data['pool'] as IpPoolType | undefined,
					dedicatedIp: data['dedicatedIp'] || undefined,
					fromDomain: data['fromDomain'] || undefined,
					toDomain: data['toDomain'] || undefined,
				});
			}
		}
	} while (cursor !== '0');

	return rules;
}
