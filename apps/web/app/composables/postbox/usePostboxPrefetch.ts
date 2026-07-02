import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ConvexClient } from 'convex/browser';

/**
 * Read-ahead for the Postbox reader: keeps the `mail.mailbox.getMessageBody`
 * query warm for messages adjacent to the list focus (j/k highlight) or the
 * open message, so pressing Enter / auto-advancing renders from warm data
 * instead of waiting on a round-trip (and, for >64KB bodies, a blob download).
 *
 * How it works:
 *  - Each warmed message holds an open Convex subscription (`client.onUpdate`)
 *    to the exact query + args the reader uses (PostboxMessageBody.vue), so
 *    the reader's own subscription resolves instantly from the client's local
 *    query cache.
 *  - Blob-stored bodies (no inline body, signed URL instead) are additionally
 *    fetched once to prime the browser HTTP cache with the same URL the
 *    reader will fetch.
 *  - Calls are debounced (~150ms) so holding j does not fan out a request per
 *    row; only the last requested targets are warmed.
 *  - The cache is LRU-capped (default 6 entries); evicted entries unsubscribe.
 *  - Strictly fail-soft: every error is swallowed — the real open still
 *    fetches through the normal path. Attachment binaries are never fetched.
 */

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_MAX_ENTRIES = 6;

type MessageBodyResult = {
	htmlInline: string | null;
	textInline: string | null;
	htmlUrl: string | null;
	textUrl: string | null;
} | null;

/** The single ConvexClient method we need — narrow for easy test fakes. */
export type PrefetchClient = Pick<ConvexClient, 'onUpdate'>;

export function usePostboxPrefetch(options?: {
	/** Injected for tests; defaults to the app Convex client. */
	client?: PrefetchClient | null;
	/** Injected for tests; defaults to global fetch. */
	fetchImpl?: (url: string) => Promise<{ text: () => Promise<string> }>;
	debounceMs?: number;
	maxEntries?: number;
}) {
	const client = options?.client !== undefined ? options.client : useConvex();
	const fetchImpl = options?.fetchImpl ?? ((url: string) => fetch(url));
	const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;

	// Insertion-ordered Map as LRU: re-warming moves an entry to the back;
	// overflow evicts from the front (least recently requested).
	const cache = new Map<string, { unsubscribe: () => void }>();
	// Blob URLs are fetched at most once per message even if the subscription
	// re-emits (live update) — this is a warm-up, not a data source.
	const blobWarmed = new Set<string>();

	let timer: ReturnType<typeof setTimeout> | null = null;
	let pendingIds: string[] = [];

	function warm(messageId: string) {
		if (!client) return;
		const existing = cache.get(messageId);
		if (existing) {
			// Already warm — just refresh its LRU position.
			cache.delete(messageId);
			cache.set(messageId, existing);
			return;
		}
		try {
			const unsubscribe = client.onUpdate(
				api.mail.mailbox.getMessageBody,
				{ messageId: messageId as Id<'mailMessages'> },
				(data: MessageBodyResult) => {
					if (!data || blobWarmed.has(messageId)) return;
					// Bodies only — never attachment binaries. Inline bodies are
					// already warm via the subscription itself.
					const url = data.htmlInline || data.textInline ? null : (data.htmlUrl ?? data.textUrl);
					if (!url) return;
					blobWarmed.add(messageId);
					void Promise.resolve()
						.then(() => fetchImpl(url))
						.then((r) => r.text())
						.catch(() => {
							// Fail-soft: allow a later retry via the normal reader path.
							blobWarmed.delete(messageId);
						});
				},
				() => {
					// Fail-soft: a failed prefetch subscription is just a cache miss.
				}
			);
			cache.set(messageId, { unsubscribe });
			while (cache.size > maxEntries) {
				const oldest = cache.keys().next().value;
				if (oldest === undefined) break;
				evict(oldest);
			}
		} catch {
			// Fail-soft: prefetch must never break the list/reader.
		}
	}

	function evict(messageId: string) {
		const entry = cache.get(messageId);
		if (!entry) return;
		cache.delete(messageId);
		blobWarmed.delete(messageId);
		try {
			entry.unsubscribe();
		} catch {
			// Fail-soft.
		}
	}

	/**
	 * Request a warm-up for the given message ids (null/undefined entries are
	 * ignored). Debounced: rapid successive calls coalesce and only the last
	 * set of targets is warmed.
	 */
	function prefetch(messageIds: Array<string | null | undefined>) {
		pendingIds = messageIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
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
		for (const id of Array.from(cache.keys())) evict(id);
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
