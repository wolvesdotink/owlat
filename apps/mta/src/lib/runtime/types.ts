/**
 * Runtime backend abstractions for the MTA.
 *
 * The MTA currently hard-couples to Redis (ioredis) for caching and
 * groupmq for queueing. These interfaces let new code reach for backend
 * primitives without binding to those specific dependencies, and let
 * tests / local dev run against in-memory implementations.
 *
 * Full migration of every ioredis call site is a multi-week effort and
 * is out of scope for the initial seam-introducing commit.
 */

// ============ CACHE ============

export interface CacheBackend {
	getProviderName(): string;
	get(key: string): Promise<string | null>;
	set(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
	incr(key: string, amount?: number): Promise<number>;
	expire(key: string, ttlSeconds: number): Promise<void>;
	del(key: string): Promise<void>;
}

// ============ QUEUE ============

/**
 * Provider-neutral message payload. The actual job shape (EmailJob, etc.)
 * is preserved as `payload`; the backend wraps it with a delivery id.
 */
export interface QueueMessage<T = unknown> {
	id: string;
	payload: T;
}

export interface QueueConsumer {
	/** Stop consuming. Returns once in-flight jobs ack/nack. */
	stop(): Promise<void>;
}

export interface QueueBackend {
	getProviderName(): string;
	enqueue<T = unknown>(
		queue: string,
		payload: T,
		opts?: { group?: string; delayMs?: number },
	): Promise<string>;
	consume<T = unknown>(
		queue: string,
		handler: (msg: QueueMessage<T>) => Promise<void>,
	): QueueConsumer;
}
