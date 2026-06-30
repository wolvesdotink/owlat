/**
 * Runtime backend factories.
 *
 * Reads QUEUE_BACKEND and CACHE_BACKEND env vars (defaulting to 'redis' /
 * 'groupmq' for production parity). The actual Redis / groupmq adapter
 * implementations live in the existing ../../redis.ts and
 * ../../queue/setup.ts entry points; this barrel just provides the seam
 * for new callers and the in-memory fallbacks for tests / dev.
 */

import { createInMemoryCacheBackend, createInMemoryQueueBackend } from './inMemory';
import type { CacheBackend, QueueBackend } from './types';

export type { CacheBackend, QueueBackend, QueueMessage, QueueConsumer } from './types';
export { createInMemoryCacheBackend, createInMemoryQueueBackend } from './inMemory';

let cachedCache: CacheBackend | null = null;
let cachedCacheType: string | null = null;
let cachedQueue: QueueBackend | null = null;
let cachedQueueType: string | null = null;

export function getCacheBackend(): CacheBackend {
	const type = (typeof process !== 'undefined' && process.env?.['CACHE_BACKEND']) || 'in-memory';
	if (cachedCache && cachedCacheType === type) return cachedCache;

	switch (type) {
		case 'in-memory':
			cachedCache = createInMemoryCacheBackend();
			cachedCacheType = 'in-memory';
			break;
		case 'redis':
			// A Redis adapter wrapping the existing getRedis() client is a follow-up.
			throw new Error(
				'CACHE_BACKEND=redis adapter not yet wired. Use in-memory for tests/dev or wait for the migration commit.',
			);
		default:
			throw new Error(`Unknown cache backend: ${type}. Supported: in-memory, redis`);
	}
	return cachedCache;
}

export function getQueueBackend(): QueueBackend {
	const type = (typeof process !== 'undefined' && process.env?.['QUEUE_BACKEND']) || 'in-memory';
	if (cachedQueue && cachedQueueType === type) return cachedQueue;

	switch (type) {
		case 'in-memory':
			cachedQueue = createInMemoryQueueBackend();
			cachedQueueType = 'in-memory';
			break;
		case 'groupmq':
			throw new Error(
				'QUEUE_BACKEND=groupmq adapter not yet wired. Use in-memory for tests/dev or wait for the migration commit.',
			);
		default:
			throw new Error(`Unknown queue backend: ${type}. Supported: in-memory, groupmq`);
	}
	return cachedQueue;
}

export function clearRuntimeBackendCaches(): void {
	cachedCache = null;
	cachedCacheType = null;
	cachedQueue = null;
	cachedQueueType = null;
}
