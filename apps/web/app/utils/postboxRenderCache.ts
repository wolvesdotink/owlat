/**
 * Session-scoped LRU cache for rendered Postbox message bodies.
 *
 * PostboxMessageBody.vue runs a non-trivial pipeline on every mount:
 * sanitize-html (parser-based allowlist) + dark-mode adaptation + tracker
 * detection + image gating + link transparency. Re-opening a thread you just
 * closed re-does all of that from scratch, which shows up as visible jank on
 * long newsletters. This cache memoises the *final* rendered output (the
 * sanitized+transformed srcdoc and the tracker detection) plus the measured
 * iframe content height, keyed by messageId + the render options that change
 * the output (scheme / showImages / loadEverything / showQuoted).
 *
 * Contract:
 *  - Message bodies are immutable once fetched, so a hit is always valid for a
 *    given (messageId, options) key — no time-based invalidation needed.
 *  - A different option value (e.g. the user shows images, or the app flips to
 *    dark) produces a different key, so stale renders are never served.
 *  - Plain Map-with-cap LRU: re-reading or re-writing a key moves it to the
 *    most-recently-used end; overflow evicts the least-recently-used entry.
 *  - The cache is a pure data structure — no reactivity, no DOM, no network —
 *    so it is trivially unit-testable and cannot break the reader if it misses.
 */

import type { TrackerDetection } from '@owlat/shared/postboxTrackers';
import type { PostboxRenderScheme } from '~/utils/postboxDarkMode';

/** Render options that change the produced srcdoc; part of the cache key. */
export interface PostboxRenderOptions {
	scheme: PostboxRenderScheme;
	showImages: boolean;
	loadEverything: boolean;
	showQuoted: boolean;
}

export interface PostboxRenderEntry {
	/** Fully sanitized + transformed iframe document. */
	srcdoc: string;
	/**
	 * Scheme the iframe actually renders with. Not always equal to the
	 * requested scheme: "designed" mail stays light even when the app is dark,
	 * and the wrapper background is keyed off this.
	 */
	renderScheme: PostboxRenderScheme;
	/** Tracker detection computed on the sanitized output (feeds the badge). */
	detection: TrackerDetection;
	/** Last measured iframe content height (px); null until first load. */
	height: number | null;
}

/** Stable string key for a message rendered under a given set of options. */
export function postboxRenderKey(messageId: string, options: PostboxRenderOptions): string {
	// Fixed field order → deterministic key; booleans as 0/1 keep it compact.
	return [
		messageId,
		options.scheme,
		options.showImages ? 1 : 0,
		options.loadEverything ? 1 : 0,
		options.showQuoted ? 1 : 0,
	].join('|');
}

export interface PostboxRenderCache {
	/** Returns the entry and marks it most-recently-used, or undefined on miss. */
	get(key: string): PostboxRenderEntry | undefined;
	/** Stores (or replaces) an entry and marks it most-recently-used. */
	set(key: string, entry: PostboxRenderEntry): void;
	/** Patches an existing entry in place (e.g. the measured height); no-op on miss. */
	update(key: string, patch: Partial<PostboxRenderEntry>): void;
	/** Test/introspection helpers. */
	has(key: string): boolean;
	readonly size: number;
	clear(): void;
}

const DEFAULT_CAP = 30;

/**
 * Create a standalone LRU render cache. Exported for tests; the app uses the
 * shared session singleton via {@link getPostboxRenderCache}.
 */
export function createPostboxRenderCache(cap: number = DEFAULT_CAP): PostboxRenderCache {
	// Insertion-ordered Map as LRU: touching an entry deletes+re-inserts it at
	// the end; overflow evicts from the front (least-recently-used).
	const map = new Map<string, PostboxRenderEntry>();

	function touch(key: string, entry: PostboxRenderEntry): void {
		map.delete(key);
		map.set(key, entry);
	}

	function evictOverflow(): void {
		while (map.size > cap) {
			const oldest = map.keys().next().value;
			if (oldest === undefined) break;
			map.delete(oldest);
		}
	}

	return {
		get(key) {
			const entry = map.get(key);
			if (entry) touch(key, entry);
			return entry;
		},
		set(key, entry) {
			touch(key, entry);
			evictOverflow();
		},
		update(key, patch) {
			const entry = map.get(key);
			if (!entry) return;
			touch(key, { ...entry, ...patch });
		},
		has(key) {
			return map.has(key);
		},
		get size() {
			return map.size;
		},
		clear() {
			map.clear();
		},
	};
}

let singleton: PostboxRenderCache | null = null;

/** The shared, session-scoped render cache used by PostboxMessageBody.vue. */
export function getPostboxRenderCache(): PostboxRenderCache {
	if (!singleton) singleton = createPostboxRenderCache();
	return singleton;
}
