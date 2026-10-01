/**
 * The round trips behind `FETCH … BODY[]`, batched.
 *
 * A body fetch used to cost four sequential round trips per message: the
 * implicit-\Seen flag write, the storage-id lookup, the URL mint and the
 * download. A desktop client's first sync of a large folder asks for thousands
 * of bodies, so that was thousands of serial hops. Now each chunk of
 * {@link RAW_URL_BATCH} messages costs one flag write and one URL mint (run
 * side by side), and its downloads run {@link RAW_DOWNLOAD_CONCURRENCY} at a
 * time while the responses still go out in sequence order.
 */

import type { ConvexClient } from '../../convex.js';
import { fn } from '../../convex.js';
import { logger } from '../../logger.js';

/**
 * Messages per URL mint and per flag write. Under the backend's cap
 * (`MAX_RAW_URL_BATCH` in apps/api `mail/imap/fetch.ts`), and small enough that
 * a client which drops mid-FETCH has had at most one chunk marked \Seen ahead
 * of what it received.
 */
export const RAW_URL_BATCH = 50;

/** Downloads in flight at once; bodies are held until their turn to be sent. */
export const RAW_DOWNLOAD_CONCURRENCY = 6;

/**
 * Add \Seen to `messageIds` with one `storeFlags` call and return each updated
 * message's resulting flag string. A message the mutation did not report (the
 * row vanished) is absent, so the caller falls back to the envelope's flags.
 */
export async function markSeenBatch(
	convex: ConvexClient,
	messageIds: readonly string[]
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (messageIds.length === 0) return out;
	const result = await convex.mutation(fn.storeFlags, {
		messageIds: [...messageIds],
		flags: ['\\Seen'],
		mode: 'add',
	});
	for (const row of result.updated) out.set(row.messageId, row.flags.join(' '));
	return out;
}

/**
 * Download URLs for a chunk of messages, keyed by message id. Any failure
 * yields an empty map: FETCH then drops the body fields of those messages
 * instead of failing the whole command, as it always has for a missing URL.
 */
export async function mintRawUrls(
	convex: ConvexClient,
	messageIds: readonly string[]
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (messageIds.length === 0) return out;
	try {
		const rows = await convex.action(fn.getRawStorageUrls, { messageIds: [...messageIds] });
		for (const row of rows) if (row.url) out.set(row.messageId, row.url);
	} catch (err) {
		logger.warn({ err, count: messageIds.length }, 'FETCH: raw URL mint failed');
	}
	return out;
}

/**
 * Pull one message's raw bytes as a `Buffer`, or null on any failure.
 *
 * Read as an `ArrayBuffer`, never `res.text()`: the stored RFC822 blob is
 * arbitrary 8-bit/binary MIME, and a UTF-8 decode would replace invalid bytes
 * with U+FFFD and change the octet count, breaking the FETCH literal framing.
 *
 * `signal` aborts the request (and its body read) when the FETCH is cancelled;
 * an aborted download also resolves to null, quietly. The request gets its own
 * short-lived signal, linked to the session's for the duration of the call:
 * handing the long-lived session signal to `fetch` directly would leave one
 * abort listener on it per download for as long as the FETCH runs.
 */
export async function downloadRaw(
	url: string | undefined,
	signal?: AbortSignal
): Promise<Buffer | null> {
	if (!url || signal?.aborted) return null;
	const request = new AbortController();
	const onAbort = (): void => request.abort(signal?.reason);
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		const res = await fetch(url, { signal: request.signal });
		if (!res.ok) return null;
		return Buffer.from(await res.arrayBuffer());
	} catch (err) {
		if (!signal?.aborted) logger.warn({ err }, 'FETCH: raw body download failed');
		return null;
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
}

/**
 * Run `work` over `items` with at most `concurrency` in flight, handing each
 * result to `emit` in input order. An item's work starts only once the item
 * `concurrency` places ahead of it has been emitted — and, when `emit`
 * returns a promise (FETCH waits for the socket to drain), once that promise
 * has settled — so no more than that many results are ever held and a slow
 * consumer slows the producer down. `work` must not reject.
 *
 * Once `signal` aborts no further work is started and nothing more is
 * emitted; work already in flight is awaited (it is expected to abort too)
 * so nothing outlives the call, and then the abort reason is thrown.
 */
export async function forEachOrdered<T, R>(
	items: readonly T[],
	concurrency: number,
	work: (item: T) => Promise<R>,
	emit: (item: T, result: R) => void | Promise<void>,
	signal?: AbortSignal
): Promise<void> {
	const width = Math.max(1, Math.floor(concurrency));
	const pending = new Map<number, Promise<R>>();
	let started = 0;
	try {
		for (let emitted = 0; emitted < items.length; emitted++) {
			if (signal?.aborted) break;
			while (started < items.length && started < emitted + width) {
				pending.set(started, work(items[started]!));
				started++;
			}
			const result = await pending.get(emitted)!;
			pending.delete(emitted);
			if (signal?.aborted) break;
			// Only a returned promise is awaited: a synchronous emit keeps the
			// loop free of extra microtask hops.
			const wait = emit(items[emitted]!, result);
			if (wait) await wait;
		}
	} finally {
		if (pending.size > 0) await Promise.allSettled(pending.values());
	}
	signal?.throwIfAborted();
}
