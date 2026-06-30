import { describe, it, expect, beforeEach } from 'vitest';
import {
	getCacheBackend,
	getQueueBackend,
	clearRuntimeBackendCaches,
	createInMemoryCacheBackend,
	createInMemoryQueueBackend,
	type CacheBackend,
	type QueueBackend,
	type QueueMessage,
} from '../index';

beforeEach(() => {
	clearRuntimeBackendCaches();
	delete (process.env as Record<string, string | undefined>).CACHE_BACKEND;
	delete (process.env as Record<string, string | undefined>).QUEUE_BACKEND;
});

// =============================================================================
// Bucket 1 — Unit: factory lifecycle
// =============================================================================
describe('runtime backends — factory lifecycle', () => {
	it('defaults to in-memory cache when CACHE_BACKEND is unset', () => {
		expect(getCacheBackend().getProviderName()).toBe('in-memory');
	});

	it('defaults to in-memory queue when QUEUE_BACKEND is unset', () => {
		expect(getQueueBackend().getProviderName()).toBe('in-memory');
	});

	it('caches the backend instance per type', () => {
		const a = getCacheBackend();
		const b = getCacheBackend();
		expect(a).toBe(b);
	});

	it('throws a typed error for not-yet-wired adapters', () => {
		(process.env as Record<string, string | undefined>).CACHE_BACKEND = 'redis';
		expect(() => getCacheBackend()).toThrow(/redis adapter not yet wired/);
		(process.env as Record<string, string | undefined>).QUEUE_BACKEND = 'groupmq';
		expect(() => getQueueBackend()).toThrow(/groupmq adapter not yet wired/);
	});
});

// =============================================================================
// Bucket 2 — Contract
// =============================================================================
describe('CacheBackend contract — in-memory honours the interface', () => {
	let cache: CacheBackend;
	beforeEach(() => {
		cache = createInMemoryCacheBackend();
	});

	it('set then get returns the value', async () => {
		await cache.set('k', 'v');
		expect(await cache.get('k')).toBe('v');
	});

	it('get for an unknown key returns null', async () => {
		expect(await cache.get('nope')).toBeNull();
	});

	it('incr starts at 1 and increments', async () => {
		expect(await cache.incr('counter')).toBe(1);
		expect(await cache.incr('counter')).toBe(2);
		expect(await cache.incr('counter', 5)).toBe(7);
	});

	it('expire causes get to return null after the TTL', async () => {
		await cache.set('k', 'v');
		await cache.expire('k', 0);
		// 0-second TTL means "expired immediately"; in-memory cache reaps on next get
		// Allow a tick for the timestamp comparison
		await new Promise((r) => setTimeout(r, 10));
		expect(await cache.get('k')).toBeNull();
	});

	it('del removes the entry', async () => {
		await cache.set('k', 'v');
		await cache.del('k');
		expect(await cache.get('k')).toBeNull();
	});
});

describe('QueueBackend contract — in-memory honours the interface', () => {
	it('enqueue + consume delivers the payload to the handler', async () => {
		const queue: QueueBackend = createInMemoryQueueBackend();
		const received: QueueMessage<string>[] = [];
		queue.consume<string>('q', async (msg) => {
			received.push(msg);
		});
		await queue.enqueue('q', 'hello');
		// Allow microtask drain
		await new Promise((r) => setImmediate(r));
		expect(received).toHaveLength(1);
		expect(received[0]?.payload).toBe('hello');
		expect(received[0]?.id).toMatch(/^msg-/);
	});
});

// =============================================================================
// Bucket 3 — Behavior-parity / regression
//
// The MTA currently uses ioredis directly; this commit only introduces the
// seam. A behavior-parity test against a real Redis would belong to a
// follow-up commit that wires the redis adapter. The in-memory adapter
// must, however, faithfully implement the public surface so tests using
// it produce the same observable behavior.
// =============================================================================
describe('CacheBackend — incr/expire/get parity with redis-like semantics', () => {
	it('TTL applied after set continues to honor expiry', async () => {
		const cache = createInMemoryCacheBackend();
		await cache.set('k', 'v', { ttlSeconds: 0.001 });
		await new Promise((r) => setTimeout(r, 5));
		expect(await cache.get('k')).toBeNull();
	});
});

// =============================================================================
// Bucket 4 — Extension proof
// =============================================================================
describe('CacheBackend / QueueBackend — extension proof', () => {
	it('a test-double CacheBackend satisfies the interface', async () => {
		const calls: string[] = [];
		const mock: CacheBackend = {
			getProviderName: () => 'mock',
			get: async (k) => {
				calls.push(`get:${k}`);
				return 'v';
			},
			set: async () => {},
			incr: async () => 1,
			expire: async () => {},
			del: async () => {},
		};
		expect(await mock.get('foo')).toBe('v');
		expect(calls).toEqual(['get:foo']);
	});

	it('a test-double QueueBackend satisfies the interface', async () => {
		const enqueued: string[] = [];
		const mock: QueueBackend = {
			getProviderName: () => 'mock',
			enqueue: async (queue) => {
				enqueued.push(queue);
				return 'id-1';
			},
			consume: () => ({ stop: async () => {} }),
		};
		await mock.enqueue('q', { foo: 'bar' });
		expect(enqueued).toEqual(['q']);
	});
});

// =============================================================================
// Bucket 5 — Failure modes
// =============================================================================
describe('runtime backends — failure modes', () => {
	it('unknown CACHE_BACKEND values produce a typed error', () => {
		(process.env as Record<string, string | undefined>).CACHE_BACKEND = 'mystery';
		expect(() => getCacheBackend()).toThrow(/Unknown cache backend: mystery/);
	});

	it('unknown QUEUE_BACKEND values produce a typed error', () => {
		(process.env as Record<string, string | undefined>).QUEUE_BACKEND = 'mystery';
		expect(() => getQueueBackend()).toThrow(/Unknown queue backend: mystery/);
	});

	it('consume.stop() removes the handler', async () => {
		const queue: QueueBackend = createInMemoryQueueBackend();
		const received: unknown[] = [];
		const consumer = queue.consume<string>('q', async (msg) => {
			received.push(msg.payload);
		});
		await queue.enqueue('q', 'first');
		await new Promise((r) => setImmediate(r));
		await consumer.stop();
		await queue.enqueue('q', 'second');
		await new Promise((r) => setImmediate(r));
		expect(received).toEqual(['first']); // second was not delivered after stop
	});
});
