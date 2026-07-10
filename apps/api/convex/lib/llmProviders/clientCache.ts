/**
 * Shared client-cache helpers for the language/embedding adapters.
 *
 * Adapters memoize their underlying AI-SDK client per `(baseUrl, key-hash)` so
 * repeated resolutions — and the language + embedding planes for the same
 * config — share one client, exactly like the single cached client this
 * replaced. These helpers keep that shape in one place so a new adapter gets
 * caching for free. Pure and isolate-safe (no `'use node'`).
 */

/**
 * A stable, non-reversible fingerprint of an API key for cache keying. No slice
 * of the raw secret is retained — only a hash — so nothing sensitive lives in
 * the retained in-memory Map keys. Uses FNV-1a (fast, deterministic; not
 * cryptographic, and never used for auth — only to distinguish distinct keys).
 */
export function keyFingerprint(apiKey: string | undefined): string {
	if (!apiKey) return 'nokey';
	let hash = 0x811c9dc5;
	for (let i = 0; i < apiKey.length; i++) {
		hash ^= apiKey.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Get the cached client for `cacheKey`, building and storing it on a miss.
 * Shared by every adapter's client factory.
 */
export function memoizeClient<T>(cache: Map<string, T>, cacheKey: string, build: () => T): T {
	const cached = cache.get(cacheKey);
	if (cached) return cached;
	const client = build();
	cache.set(cacheKey, client);
	return client;
}
