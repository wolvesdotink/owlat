/**
 * Redis client factory with reconnection handling
 */

import Redis from 'ioredis';
import { logger } from './monitoring/logger.js';
import { withScriptCacheRecovery } from './lib/redisScriptCache.js';

let client: Redis | null = null;

/**
 * Get or create the Redis client singleton
 *
 * The client self-heals after a Redis restart empties the server-side Lua
 * script cache: without that, GroupMQ's memoised script SHAs outlive the
 * connection and every queue operation fails `NOSCRIPT` forever. See
 * `lib/redisScriptCache.ts`.
 */
export function getRedis(url: string): Redis {
	if (client) return client;

	client = withScriptCacheRecovery(
		new Redis(url, {
			maxRetriesPerRequest: 3,
			retryStrategy(times) {
				const delay = Math.min(times * 200, 5000);
				logger.warn({ attempt: times, delay }, 'Redis reconnecting');
				return delay;
			},
			reconnectOnError(err) {
				const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
				return targetErrors.some((e) => err.message.includes(e));
			},
		})
	);

	client.on('connect', () => logger.info('Redis connected'));
	client.on('error', (err) => logger.error({ err }, 'Redis error'));
	client.on('close', () => logger.warn('Redis connection closed'));

	return client;
}

/**
 * Check if Redis is healthy
 */
export async function isRedisHealthy(): Promise<boolean> {
	if (!client) return false;
	try {
		const result = await client.ping();
		return result === 'PONG';
	} catch {
		return false;
	}
}

/**
 * Gracefully close the Redis connection
 */
export async function closeRedis(): Promise<void> {
	if (client) {
		await client.quit();
		client = null;
	}
}
