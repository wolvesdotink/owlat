/**
 * Last-known feature flags, remembered per deployment in localStorage.
 *
 * `useFeatureFlag` renders from the shipped defaults until the live
 * `getFeatureFlags` subscription answers, and Postbox, the inbox and chat all
 * default off. On every boot the nav therefore drew without them and popped them
 * in a round trip later, and every query gated on one of those flags waited for
 * the same round trip before it could even subscribe. Seeding the fallback from
 * the flags this browser last saw makes the first frame match the last session
 * (stale-while-revalidate); the live answer still replaces the seed the moment
 * it arrives.
 *
 * Flags are instance configuration served by a public query, not per-member
 * data, and they gate UX only: every flag-gated backend function re-checks its
 * flag server-side. A stale seed can at worst show a nav item for one round
 * trip. The exception is anything whose client-side effect cannot be taken back
 * (see `LIVE_ONLY_FLAGS`).
 *
 * The cache is keyed by the Convex deployment URL rather than by organization:
 * the flag map is a deployment singleton, the desktop app holds one deployment
 * per workspace, and the URL is known synchronously at boot, before the session
 * (and with it the active organization) has loaded.
 */

import type { FeatureFlagKey } from '@owlat/shared/featureFlags';

export const FEATURE_FLAG_CACHE_KEY = 'owlat:feature-flags:v1';

/** Deployments remembered at once; the least recently written one drops out. */
export const FEATURE_FLAG_CACHE_MAX_SCOPES = 8;

/**
 * Flags whose cached value is never used as a seed. `analytics.posthog` starts
 * shipping events to a third party the moment it reads true; if an admin has
 * since switched it off, a stale `true` would send a burst before the live
 * answer revokes it. These stay at their shipped default until the server says
 * otherwise.
 */
export const LIVE_ONLY_FLAGS: readonly FeatureFlagKey[] = ['analytics.posthog'];

export type CachedFlagMap = Partial<Record<FeatureFlagKey, boolean>>;

interface CacheEntry {
	flags: Record<string, boolean>;
	savedAt: number;
}

type CacheShape = Record<string, CacheEntry>;

function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		// Access can throw (sandboxed iframe, storage disabled by policy).
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only boolean entries survive: anything else is a corrupt or foreign write. */
function booleanEntries(value: unknown): Record<string, boolean> {
	const result: Record<string, boolean> = {};
	if (!isRecord(value)) return result;
	for (const [key, flag] of Object.entries(value)) {
		if (typeof flag === 'boolean') result[key] = flag;
	}
	return result;
}

function readAll(store: Storage): CacheShape {
	let parsed: unknown;
	try {
		const raw = store.getItem(FEATURE_FLAG_CACHE_KEY);
		if (raw === null) return {};
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!isRecord(parsed)) return {};
	const result: CacheShape = {};
	for (const [scope, entry] of Object.entries(parsed)) {
		if (!isRecord(entry)) continue;
		result[scope] = {
			flags: booleanEntries(entry['flags']),
			savedAt: typeof entry['savedAt'] === 'number' ? entry['savedAt'] : 0,
		};
	}
	return result;
}

/**
 * The flags last seen on `scope`, without the live-only ones, or null when this
 * browser has none for it (or no scope is known).
 */
export function readCachedFeatureFlags(scope: string | null): CachedFlagMap | null {
	if (!scope) return null;
	const store = storage();
	if (!store) return null;
	const entry = readAll(store)[scope];
	if (!entry) return null;
	const flags: Record<string, boolean> = { ...entry.flags };
	for (const key of LIVE_ONLY_FLAGS) delete flags[key];
	return Object.keys(flags).length > 0 ? (flags as CachedFlagMap) : null;
}

/** Remember the live flag map for `scope`. Skips the write when nothing changed. */
export function writeCachedFeatureFlags(
	scope: string | null,
	flags: Record<string, boolean>,
	now: number = Date.now()
): void {
	if (!scope) return;
	const store = storage();
	if (!store) return;
	const all = readAll(store);
	const next = booleanEntries(flags);
	const previous = all[scope];
	if (previous && JSON.stringify(previous.flags) === JSON.stringify(next)) return;

	all[scope] = { flags: next, savedAt: now };
	const kept = Object.entries(all)
		.sort(([, a], [, b]) => b.savedAt - a.savedAt)
		.slice(0, FEATURE_FLAG_CACHE_MAX_SCOPES);
	try {
		store.setItem(FEATURE_FLAG_CACHE_KEY, JSON.stringify(Object.fromEntries(kept)));
	} catch {
		// Quota exceeded or storage disabled: the cache is an optimisation only.
	}
}

/** Forget every remembered flag map (sign-out). */
export function clearCachedFeatureFlags(): void {
	const store = storage();
	if (!store) return;
	try {
		store.removeItem(FEATURE_FLAG_CACHE_KEY);
	} catch {
		// Storage disabled: nothing was persisted either.
	}
}
