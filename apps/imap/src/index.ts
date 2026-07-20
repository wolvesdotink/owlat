/**
 * Owlat IMAP server entry point.
 */

import IORedis from 'ioredis';
import { loadConfig } from './config.js';
import { createConvexClient } from './convex.js';
import { startImapServer } from './server.js';
import { AuthRateLimiter } from './rateLimit.js';
import { logger } from './logger.js';
import { pathToFileURL } from 'node:url';

export async function main() {
	const config = loadConfig();
	const convex = createConvexClient(config);

	let redis: IORedis | null = null;
	if (config.redisUrl) {
		redis = new IORedis(config.redisUrl, {
			lazyConnect: false,
			maxRetriesPerRequest: 2,
			enableOfflineQueue: false,
		});
		redis.on('error', (err) => {
			logger.warn({ err }, 'redis error — auth rate limiter will fail-open');
		});
	} else {
		logger.warn('REDIS_URL not set — IMAP auth rate limiter disabled (fails open)');
	}

	const rateLimiter = new AuthRateLimiter(redis, config.authRateLimit);
	const { server } = startImapServer(config, convex, rateLimiter);

	const shutdown = (signal: string) => {
		logger.info({ signal }, 'shutting down');
		server.close(() => {
			redis?.disconnect();
			process.exit(0);
		});
		// Hard kill after 10s if connections refuse to close
		setTimeout(() => process.exit(1), 10_000).unref();
	};

	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
	void main().catch((err) => {
		logger.error({ err }, 'fatal startup error');
		process.exit(1);
	});
}
