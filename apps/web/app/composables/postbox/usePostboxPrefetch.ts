import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ConvexClient } from 'convex/browser';
import type { FunctionReturnType } from 'convex/server';
import { holdConvexQuery } from '~/lib/convexQueryHold';
import { clearResolvedPostboxBodies, resolvePostboxMessageBody } from './postboxBodyResolver';
import { threadPageArgs } from './postboxThreadPage';

/**
 * Read-ahead for the Postbox reader (plan 2.5).
 *
 * For each warmed row it holds the two queries the reader opens with, the
 * thread's newest page (`listThreadMessages`) and the inline body (`getMessageInlineBody`),
 * as subscriptions in the shared registry. Opening that row then joins live,
 * loaded subscriptions and renders in the same tick. A hold is released when
 * the row falls out of the small LRU or the list unmounts, and the registry
 * then keeps the query warm for its linger window before it closes.
 *
 * Only a body stored as a blob still needs the action (queries cannot mint
 * storage URLs). Those are resolved through a bounded action queue into the
 * client-scoped body cache the reader consumes. That cache outlives this
 * composable on purpose, and is dropped on mailbox, account and organization
 * changes instead (see usePostboxBodyCacheScope).
 *
 * Everything here is debounced, capped and strictly fail-soft; the reader's
 * own load is always authoritative.
 */

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_MAX_ENTRIES = 6;
const DEFAULT_MAX_CONCURRENT = 2;

/** The ConvexClient methods we need — narrow for easy test fakes. */
export type PrefetchClient = Pick<ConvexClient, 'action' | 'query' | 'onUpdate'>;

type InlineBody = FunctionReturnType<typeof api.mail.mailbox.messages.getMessageInlineBody>;

type CacheEntry = {
	token: symbol;
	/** Releases the held thread and inline-body subscriptions. */
	release: () => void;
	/** The blob download, for bodies too large to travel inline. */
	blob: 'none' | 'queued' | 'loading' | 'settled';
};

/** True when the inline body query reports a body that only exists as a blob. */
export function inlineBodyNeedsBlob(body: InlineBody | undefined): boolean {
	if (!body) return false;
	if (body.htmlInline !== null || body.textInline !== null) return false;
	return body.hasHtmlBlob || body.hasTextBlob;
}

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
		const entry = cache.get(messageId);
		if (!entry) return;
		cache.delete(messageId);
		entry.release();
	}

	function enforceLimit() {
		while (cache.size > maxEntries) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) return;
			evict(oldest);
		}
	}

	async function runBlobWarm(messageId: string, token: symbol) {
		if (!client) return;
		try {
			await resolvePostboxMessageBody(client, messageId, { fetchImpl, blobOnly: true });
			const current = cache.get(messageId);
			if (current?.token === token) current.blob = 'settled';
		} catch {
			// An action or download failure is not warm and may be retried when the
			// body query next reports the blob; the reader fetches for itself anyway.
			const current = cache.get(messageId);
			if (current?.token === token) current.blob = 'none';
		}
	}

	function pumpQueue() {
		while (activeCount < maxConcurrent && queue.length > 0) {
			const queued = queue.shift();
			if (!queued) return;
			const entry = cache.get(queued.messageId);
			if (!entry || entry.token !== queued.token || entry.blob !== 'queued') continue;

			entry.blob = 'loading';
			activeCount += 1;
			void runBlobWarm(queued.messageId, queued.token).finally(() => {
				activeCount -= 1;
				pumpQueue();
			});
		}
	}

	function queueBlob(messageId: string, token: symbol) {
		const entry = cache.get(messageId);
		if (!entry || entry.token !== token || entry.blob !== 'none') return;
		entry.blob = 'queued';
		queue.push({ messageId, token });
		pumpQueue();
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
		const entry: CacheEntry = { token, release: () => {}, blob: 'none' };
		cache.set(messageId, entry);
		const args = { messageId: messageId as Id<'mailMessages'> };
		const releaseThread = holdConvexQuery(
			client,
			api.mail.mailbox.messages.listThreadMessages,
			threadPageArgs(messageId)
		);
		const releaseBody = holdConvexQuery(
			client,
			api.mail.mailbox.messages.getMessageInlineBody,
			args,
			(body) => {
				if (inlineBodyNeedsBlob(body)) queueBlob(messageId, token);
			}
		);
		entry.release = () => {
			releaseThread();
			releaseBody();
		};
		enforceLimit();
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

	/** Cancel pending and queued warm-ups and release every held subscription
	 * (the registry keeps each warm for its linger window). Bodies already
	 * resolved stay in the shared cache for the reader. */
	function dispose() {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		pendingIds = [];
		queue.length = 0;
		for (const messageId of Array.from(cache.keys())) evict(messageId);
	}

	/** dispose() plus dropping the shared resolved bodies. */
	function clear() {
		dispose();
		if (client) clearResolvedPostboxBodies(client);
	}

	if (getCurrentScope()) {
		onScopeDispose(dispose);
	}

	return {
		prefetch,
		dispose,
		clear,
		/** Test/introspection helpers. */
		isWarm: (messageId: string) => cache.has(messageId),
		size: () => cache.size,
	};
}
