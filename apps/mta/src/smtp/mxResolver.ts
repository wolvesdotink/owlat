/**
 * DNS MX resolution with Redis-backed caching
 *
 * Resolves recipient domain MX records and caches results
 * in Redis for sharing across multiple MTA instances.
 */

import { resolveMx } from 'dns/promises';
import { domainToASCII } from 'node:url';
import type Redis from 'ioredis';
import { logger } from '../monitoring/logger.js';

const MX_CACHE_TTL = 3600; // 1 hour in seconds
const MX_CACHE_PREFIX = 'mta:mx-cache:';
const MAX_CACHED_MX_HOSTS = 50;

export interface MxHost {
	exchange: string;
	priority: number;
}

function isMxHost(value: unknown): value is MxHost {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const record = value as Partial<MxHost>;
	return (
		typeof record.exchange === 'string' &&
		record.exchange.length > 0 &&
		record.exchange.length <= 253 &&
		typeof record.priority === 'number' &&
		Number.isSafeInteger(record.priority) &&
		record.priority >= 0 &&
		record.priority <= 65_535
	);
}

function parseCachedMxHosts(raw: string): MxHost[] | null {
	try {
		const value = JSON.parse(raw) as unknown;
		return Array.isArray(value) && value.length <= MAX_CACHED_MX_HOSTS && value.every(isMxHost)
			? value
			: null;
	} catch {
		return null;
	}
}

/**
 * Resolve MX hosts for a domain, using Redis cache
 * Returns MX hosts sorted by priority (lowest first = highest priority)
 */
export async function resolveMxHosts(redis: Redis, domain: string): Promise<MxHost[]> {
	// IDN-normalize U-labels to A-labels (RFC 6531 §3.7.1): DNS MX lookup needs
	// punycode, so an internationalized recipient domain (`例え.test`) would
	// otherwise resolve to `[]` and the mail would be undeliverable even to an
	// SMTPUTF8-capable MX. `domainToASCII` returns '' for an undecodable label —
	// fall back to the raw name so the DNS query (and its failure) is unchanged.
	const ascii = domainToASCII(domain);
	const resolveName = ascii === '' ? domain : ascii;
	const cacheKey = `${MX_CACHE_PREFIX}${resolveName.toLowerCase()}`;

	// Try cache first
	try {
		const cached = await redis.get(cacheKey);
		if (cached) {
			const parsed = parseCachedMxHosts(cached);
			if (parsed) return parsed;
			logger.warn({ domain }, 'Ignoring malformed MX cache entry');
		}
	} catch (err) {
		logger.warn({ domain, err }, 'MX cache read failed, falling back to DNS');
	}

	// Resolve via DNS
	try {
		const records = await resolveMx(resolveName);
		const sorted = records
			.slice(0, MAX_CACHED_MX_HOSTS)
			.sort((a, b) => a.priority - b.priority)
			.map((r) => ({ exchange: r.exchange.toLowerCase().replace(/\.$/, ''), priority: r.priority }))
			.filter(isMxHost);

		// Cache in Redis
		try {
			await redis.set(cacheKey, JSON.stringify(sorted), 'EX', MX_CACHE_TTL);
		} catch (err) {
			logger.warn({ domain, err }, 'MX cache write failed');
		}

		return sorted;
	} catch (err) {
		logger.error({ domain, err }, 'MX DNS resolution failed');
		return [];
	}
}

/**
 * Get the best MX hosts as hostnames (for connection attempts)
 */
export async function getMxHostnames(redis: Redis, domain: string): Promise<string[]> {
	const hosts = await resolveMxHosts(redis, domain);
	return hosts.map((h) => h.exchange);
}
