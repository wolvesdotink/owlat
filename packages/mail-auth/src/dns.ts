/**
 * Cached, injectable DNS resolver for mail-auth (SPF / DMARC).
 *
 * `createCachedResolver` wraps an injectable base resolver with a Redis TTL
 * cache. The design goals (from the Own-the-Inbound plan):
 *
 *   - respect the record TTL, capped at 1 hour;
 *   - negative-cache NXDOMAIN / NODATA (empty answers) for 5 minutes;
 *   - FAIL OPEN when Redis is unavailable — a Redis error never blocks or
 *     corrupts resolution, it just bypasses the cache;
 *   - the SPF lookup budget counts RESOLVER CALLS, not cache hits: the base
 *     resolver is invoked once per cache miss and never on a hit, so a warm
 *     cache serves a term without a network round-trip while the RFC 7208
 *     §4.6.4 mechanism budget (enforced in `spf.ts`) is unaffected.
 *
 * The base resolver returns records plus the authoritative TTL; `toSpfResolver`
 * adapts a `DnsResolver` down to the `SpfDnsResolver` shape `checkSpf` expects.
 */

import type { SpfDnsResolver } from './spf.js';

export type DnsRecordType = 'A' | 'AAAA' | 'MX' | 'TXT';

/** A resolved DNS answer plus the TTL (seconds) to cache it for. */
export interface CachedDnsAnswer {
	/** Record payload as returned by the underlying resolver. */
	readonly records: unknown[];
	/** Authoritative TTL in seconds (pre-cap). */
	readonly ttl: number;
}

/** The injectable base resolver: performs exactly one real DNS query. */
export type DnsResolver = (name: string, type: DnsRecordType) => Promise<CachedDnsAnswer>;

/**
 * The minimal Redis surface the cache needs. Structurally satisfied by both
 * `ioredis` and `ioredis-mock`, so no hard dependency on a client is required.
 */
export interface RedisLike {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
}

/** 1-hour cap on any positive answer's cache TTL. */
export const MAX_DNS_TTL_SECONDS = 3600;
/** NXDOMAIN / NODATA answers are negative-cached for 5 minutes. */
export const NEGATIVE_TTL_SECONDS = 300;

const CACHE_PREFIX = 'mailauth:dns:';

/** Cache entry shape stored (as JSON) in Redis. */
interface CacheEntry {
	readonly records: unknown[];
}

export interface CachedResolverOptions {
	/** Redis key prefix (default `mailauth:dns:`). */
	readonly keyPrefix?: string;
	/** Positive-answer TTL cap in seconds (default 3600). */
	readonly maxTtlSeconds?: number;
	/** Negative-answer TTL in seconds (default 300). */
	readonly negativeTtlSeconds?: number;
}

/**
 * Wrap `base` with a Redis TTL cache. Pass `redis = null` to disable caching
 * entirely (every call goes straight to `base`).
 */
export function createCachedResolver(
	base: DnsResolver,
	redis: RedisLike | null,
	options: CachedResolverOptions = {}
): DnsResolver {
	const prefix = options.keyPrefix ?? CACHE_PREFIX;
	const maxTtl = options.maxTtlSeconds ?? MAX_DNS_TTL_SECONDS;
	const negTtl = options.negativeTtlSeconds ?? NEGATIVE_TTL_SECONDS;

	return async (name, type) => {
		const key = `${prefix}${type}:${name.toLowerCase()}`;

		// 1. Cache read. FAIL OPEN: any Redis error bypasses the cache entirely.
		if (redis) {
			const cached = await safeGet(redis, key);
			if (cached !== null) {
				const entry = parseEntry(cached);
				if (entry) {
					// A cache hit — the base resolver (and thus the network) is NOT
					// touched. TTL is reported as 0 (already-cached, no re-store needed).
					return { records: entry.records, ttl: 0 };
				}
			}
		}

		// 2. Miss (or Redis down) → exactly one real resolver call.
		const answer = await base(name, type);

		// 3. Cache write. Positive answers respect the record TTL capped at 1h;
		//    empty answers (NXDOMAIN/NODATA) are negative-cached for 5 min.
		if (redis) {
			const isNegative = answer.records.length === 0;
			const ttl = isNegative ? negTtl : clampTtl(answer.ttl, maxTtl);
			const entry: CacheEntry = { records: answer.records };
			await safeSet(redis, key, JSON.stringify(entry), ttl);
		}

		return answer;
	};
}

/**
 * Adapt a `DnsResolver` (records + TTL) down to the `SpfDnsResolver` shape
 * `checkSpf` consumes (records only). Wrap a cached resolver with this to run
 * SPF over the cache while keeping the frozen evaluator untouched.
 */
export function toSpfResolver(resolver: DnsResolver): SpfDnsResolver {
	return async (name, type) => (await resolver(name, type)).records;
}

/** Clamp a positive TTL to `[1, maxTtl]` seconds. */
function clampTtl(ttl: number, maxTtl: number): number {
	const floored = Math.floor(ttl);
	if (!Number.isFinite(floored) || floored < 1) return 1;
	return Math.min(floored, maxTtl);
}

/** `redis.get` that fails open (returns null) on any client error. */
async function safeGet(redis: RedisLike, key: string): Promise<string | null> {
	try {
		return await redis.get(key);
	} catch {
		return null;
	}
}

/** `redis.set` that fails open (swallows) on any client error — caching is best-effort. */
async function safeSet(redis: RedisLike, key: string, value: string, ttl: number): Promise<void> {
	try {
		await redis.set(key, value, 'EX', ttl);
	} catch {
		// Best-effort: a write failure just means the next lookup is a cache miss.
	}
}

/** Parse a stored cache entry; returns null on any malformed payload. */
function parseEntry(raw: string): CacheEntry | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (
		value &&
		typeof value === 'object' &&
		Array.isArray((value as { records?: unknown }).records)
	) {
		return { records: (value as CacheEntry).records };
	}
	return null;
}
