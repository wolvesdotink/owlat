/**
 * Shared client-cache helpers for the language/embedding adapters.
 *
 * Adapters memoize their underlying AI-SDK client per `(baseUrl, key-hash)` so
 * repeated resolutions — and the language + embedding planes for the same
 * config — share one client, exactly like the single cached client this
 * replaced. These helpers keep that shape in one place so a new adapter gets
 * caching for free. Pure and isolate-safe (no `'use node'`).
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ProviderClientConfig } from './types';

/** The client the `@ai-sdk/openai-compatible` provider factory returns. */
export type OpenAICompatibleClient = ReturnType<typeof createOpenAICompatible>;

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
 * The cache key for a hosted adapter's client: the (optional) base-URL override
 * plus a non-reversible fingerprint of the API key. Two configs share a client
 * iff they target the same endpoint with the same key. Every hosted adapter
 * keys its client Map with this, so the key shape lives in one place.
 */
export function hostedCacheKey(cfg: ProviderClientConfig): string {
	return `${cfg.baseUrl ?? ''}::${keyFingerprint(cfg.apiKey)}`;
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

/**
 * Build (or return the cached) `@ai-sdk/openai-compatible` client for
 * `(baseURL, key-fingerprint)`. The single place the `createOpenAICompatible`
 * construction shape lives: the openai-compatible (local) and openrouter
 * adapters differ only in the provider `name` and their base-URL policy
 * (required vs. defaulted) — both of which the caller resolves before calling.
 * The cache key stores only a non-reversible hash of the key, never a slice of
 * the raw secret.
 */
export function openAICompatibleClient(
	cache: Map<string, OpenAICompatibleClient>,
	name: string,
	baseURL: string,
	apiKey: string | undefined
): OpenAICompatibleClient {
	const cacheKey = `${baseURL}::${keyFingerprint(apiKey)}`;
	return memoizeClient(cache, cacheKey, () =>
		createOpenAICompatible({
			name,
			baseURL,
			...(apiKey ? { apiKey } : {}),
		})
	);
}
