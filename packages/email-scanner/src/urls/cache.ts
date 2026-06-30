/**
 * URL Reputation Cache Interface
 *
 * Abstract cache interface for storing and retrieving URL reputation verdicts.
 * Consumers implement this interface based on their storage backend:
 * - Convex: uses a `urlReputationCache` database table
 * - MTA: could use Redis
 *
 * Cache TTLs:
 * - Clean URLs: 24 hours (safe to cache longer)
 * - Flagged URLs: 1 hour (need to re-check more frequently for delistings)
 */

import type { CachedVerdict, UrlReputationCache, UrlVerdict } from '../types.js';

/** TTL for clean URL verdicts (24 hours) */
export const CLEAN_TTL_MS = 24 * 60 * 60 * 1000;

/** TTL for flagged URL verdicts (1 hour) */
export const FLAGGED_TTL_MS = 60 * 60 * 1000;

/**
 * Create a CachedVerdict object with appropriate TTL.
 */
export function createCachedVerdict(
	verdict: UrlVerdict,
	source: string,
	threats?: string[],
): CachedVerdict {
	const now = Date.now();
	const ttl = verdict === 'safe' ? CLEAN_TTL_MS : FLAGGED_TTL_MS;

	return {
		verdict,
		source,
		threats,
		checkedAt: now,
		expiresAt: now + ttl,
	};
}

/**
 * Check if a cached verdict has expired.
 */
export function isExpired(cached: CachedVerdict): boolean {
	return Date.now() > cached.expiresAt;
}

/**
 * In-memory cache implementation for testing and short-lived processes.
 * NOT suitable for production use (no persistence, no sharing between instances).
 */
export class InMemoryUrlCache implements UrlReputationCache {
	private cache = new Map<string, CachedVerdict>();

	async get(urlHash: string): Promise<CachedVerdict | null> {
		const cached = this.cache.get(urlHash);
		if (!cached) return null;

		if (isExpired(cached)) {
			this.cache.delete(urlHash);
			return null;
		}

		return cached;
	}

	async set(urlHash: string, verdict: CachedVerdict): Promise<void> {
		this.cache.set(urlHash, verdict);
	}

	/** Clear all cached entries (for testing). */
	clear(): void {
		this.cache.clear();
	}

	/** Get the number of cached entries (for monitoring). */
	get size(): number {
		return this.cache.size;
	}
}
