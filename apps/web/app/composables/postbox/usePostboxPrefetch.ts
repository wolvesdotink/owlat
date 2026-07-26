import type { ConvexClient } from 'convex/browser';
import { clearResolvedPostboxBodies, resolvePostboxMessageBody } from './postboxBodyResolver';

/**
 * Read-ahead for the Postbox reader. URL minting belongs in an action, so the
 * warm-up is a bounded action queue rather than a live query subscription.
 *
 * Storage-backed bodies are fully resolved into a bounded client-scoped cache
 * that the reader consumes. Calls remain debounced, LRU-capped and strictly
 * fail-soft; the real reader load is always authoritative.
 */

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_MAX_ENTRIES = 6;
const DEFAULT_MAX_CONCURRENT = 2;

/** The single ConvexClient method we need — narrow for easy test fakes. */
export type PrefetchClient = Pick<ConvexClient, 'action'>;

type CacheEntry = {
	token: symbol;
	state: 'queued' | 'loading' | 'settled';
};

export function usePostboxPrefetch(options?: {
	/** Injected for tests; defaults to the app Convex client. */
	client?: PrefetchClient | null;
	/** Injected for tests; defaults to global fetch. */
	fetchImpl?: (url: string) => Promise<{ text: () => Promise<string> }>;
	debounceMs?: number;
	maxEntries?: number;
	maxConcurrent?: number;
}) {
	const client = options?.client !== undefined ? options.client : useConvex();
	const fetchImpl = options?.fetchImpl ?? ((url: string) => fetch(url));
	const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_MAX_ENTRIES);
	const maxConcurrent = Math.max(1, options?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);

	// Insertion-ordered Map as LRU: re-warming moves an entry to the back;
	// overflow evicts from the front (least recently requested).
	const cache = new Map<string, CacheEntry>();
	const queue: Array<{ messageId: string; token: symbol }> = [];

	let activeCount = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pendingIds: string[] = [];

	function evict(messageId: string) {
		cache.delete(messageId);
	}

	function enforceLimit() {
		while (cache.size > maxEntries) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) return;
			evict(oldest);
		}
	}

	async function runWarm(messageId: string, token: symbol) {
		if (!client) return;
		try {
			await resolvePostboxMessageBody(client, messageId, fetchImpl);
			const entry = cache.get(messageId);
			if (!entry || entry.token !== token) return;
			const current = cache.get(messageId);
			if (current?.token === token) current.state = 'settled';
		} catch {
			// An action failure is not warm and may be retried later. A blob
			// download failure is equally harmless: the reader performs its own
			// authoritative fetch when opened.
			const current = cache.get(messageId);
			if (current?.token === token) evict(messageId);
		}
	}

	function pumpQueue() {
		while (activeCount < maxConcurrent && queue.length > 0) {
			const queued = queue.shift();
			if (!queued) return;
			const entry = cache.get(queued.messageId);
			if (!entry || entry.token !== queued.token || entry.state !== 'queued') continue;

			entry.state = 'loading';
			activeCount += 1;
			void runWarm(queued.messageId, queued.token).finally(() => {
				activeCount -= 1;
				pumpQueue();
			});
		}
	}

	function warm(messageId: string) {
		if (!client) return;
		const existing = cache.get(messageId);
		if (existing) {
			cache.delete(messageId);
			cache.set(messageId, existing);
			return;
		}

		const token = Symbol(messageId);
		cache.set(messageId, { token, state: 'queued' });
		queue.push({ messageId, token });
		enforceLimit();
		pumpQueue();
	}

	/**
	 * Request a warm-up for the given message ids (null/undefined entries are
	 * ignored). Debounced: rapid successive calls coalesce and only the last
	 * set of targets is warmed.
	 */
	function prefetch(messageIds: Array<string | null | undefined>) {
		pendingIds = Array.from(
			new Set(messageIds.filter((id): id is string => typeof id === 'string' && id.length > 0))
		).slice(0, maxEntries);
		if (timer !== null) clearTimeout(timer);
		if (pendingIds.length === 0) {
			timer = null;
			return;
		}
		timer = setTimeout(() => {
			timer = null;
			for (const id of pendingIds) warm(id);
			pendingIds = [];
		}, debounceMs);
	}

	function clear() {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		pendingIds = [];
		queue.length = 0;
		cache.clear();
		if (client) clearResolvedPostboxBodies(client);
	}

	if (getCurrentScope()) {
		onScopeDispose(clear);
	}

	return {
		prefetch,
		clear,
		/** Test/introspection helpers. */
		isWarm: (messageId: string) => cache.has(messageId),
		size: () => cache.size,
	};
}
