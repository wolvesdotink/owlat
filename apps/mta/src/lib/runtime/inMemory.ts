/**
 * In-memory implementations of CacheBackend and QueueBackend.
 *
 * Used in tests and as a no-dependency fallback for single-process self-host
 * deployments where running Redis isn't justified. NOT suitable for
 * multi-process deployments — each process gets its own isolated state.
 */

import type { CacheBackend, QueueBackend, QueueConsumer, QueueMessage } from './types.js';

interface CacheEntry {
	value: string;
	expiresAt: number | null;
}

export function createInMemoryCacheBackend(): CacheBackend {
	const store = new Map<string, CacheEntry>();

	const isExpired = (entry: CacheEntry): boolean =>
		entry.expiresAt !== null && entry.expiresAt < Date.now();

	const reapIfExpired = (key: string): void => {
		const entry = store.get(key);
		if (entry && isExpired(entry)) store.delete(key);
	};

	return {
		getProviderName: () => 'in-memory',
		async get(key) {
			reapIfExpired(key);
			return store.get(key)?.value ?? null;
		},
		async set(key, value, opts) {
			const expiresAt = opts?.ttlSeconds ? Date.now() + opts.ttlSeconds * 1000 : null;
			store.set(key, { value, expiresAt });
		},
		async incr(key, amount = 1) {
			reapIfExpired(key);
			const current = Number(store.get(key)?.value ?? 0);
			const next = current + amount;
			store.set(key, {
				value: String(next),
				expiresAt: store.get(key)?.expiresAt ?? null,
			});
			return next;
		},
		async expire(key, ttlSeconds) {
			const entry = store.get(key);
			if (!entry) return;
			store.set(key, { ...entry, expiresAt: Date.now() + ttlSeconds * 1000 });
		},
		async del(key) {
			store.delete(key);
		},
	};
}

export function createInMemoryQueueBackend(): QueueBackend {
	const queues = new Map<string, QueueMessage[]>();
	let idCounter = 0;
	const consumers = new Map<string, Set<(msg: QueueMessage) => Promise<void>>>();

	const drainQueue = (queue: string): void => {
		const handlers = consumers.get(queue);
		if (!handlers || handlers.size === 0) return;
		const pending = queues.get(queue);
		if (!pending || pending.length === 0) return;
		// Round-robin to the first handler; sufficient for single-process tests
		const handler = handlers.values().next().value;
		if (!handler) return;
		const msg = pending.shift()!;
		// fire-and-forget — tests await elsewhere
		void handler(msg).catch(() => {
			// best-effort in-memory: log to console; production semantics
			// are the responsibility of a real queue backend.
		});
	};

	return {
		getProviderName: () => 'in-memory',
		async enqueue(queue, payload, opts) {
			const id = `msg-${++idCounter}`;
			const msg: QueueMessage = { id, payload };
			const list = queues.get(queue) ?? [];
			if (opts?.delayMs) {
				setTimeout(() => {
					list.push(msg);
					queues.set(queue, list);
					drainQueue(queue);
				}, opts.delayMs);
			} else {
				list.push(msg);
				queues.set(queue, list);
				drainQueue(queue);
			}
			return id;
		},
		consume<T>(
			queue: string,
			handler: (msg: QueueMessage<T>) => Promise<void>,
		): QueueConsumer {
			const handlers = consumers.get(queue) ?? new Set();
			handlers.add(handler as (msg: QueueMessage) => Promise<void>);
			consumers.set(queue, handlers);
			// Drain anything already in the queue
			drainQueue(queue);
			return {
				async stop() {
					handlers.delete(handler as (msg: QueueMessage) => Promise<void>);
				},
			};
		},
	};
}
