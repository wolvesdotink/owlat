/**
 * Redis client factory with reconnection handling
 */

import Redis from 'ioredis';
import { logger } from './monitoring/logger.js';

let client: Redis | null = null;

/**
 * Get or create the Redis client singleton
 */
export function getRedis(url: string): Redis {
	if (client) return client;

	client = new Redis(url, {
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
	});

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
