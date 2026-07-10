/**
 * [5] SMTP Response Intelligence
 *
 * Tracks and learns from SMTP response codes per domain.
 * Detects patterns (e.g., "this domain is temporarily rejecting all mail")
 * to avoid wasting connection attempts.
 *
 * Works alongside domainThrottle: throttle handles rate,
 * this handles pattern-based deferral.
 */

import type Redis from 'ioredis';
import type { SmtpDomainStatus } from '../types.js';
import { logger } from '../monitoring/logger.js';

const INTEL_PREFIX = 'mta:smtp-intel:';
const RETRY_PREFIX = 'mta:smtp-intel:retry:';
const HISTORY_SIZE = 50;
const TTL_DAYS = 7;
const TTL_SECONDS = TTL_DAYS * 86400;

// Thresholds for domain health classification
const DEGRADED_4XX_RATIO = 0.5;
const BLOCKING_5XX_RATIO = 0.7;
const BLOCKING_MIN_RESPONSES = 10;
const DEGRADED_DEFER_MS = 120_000; // 2 minutes
const BLOCKING_DEFER_MS = 300_000; // 5 minutes

/**
 * Bucket an SMTP status code into its response class.
 */
function codeClass(code: number): '2xx' | '4xx' | '5xx' | 'other' {
	if (code >= 200 && code < 300) return '2xx';
	if (code >= 400 && code < 500) return '4xx';
	if (code >= 500 && code < 600) return '5xx';
	return 'other';
}

/**
 * Check if sends to a domain should be deferred based on recent SMTP patterns
 * Returns the number of milliseconds to defer, or 0 if sending is OK
 */
export async function shouldDefer(redis: Redis, domain: string): Promise<number> {
	const retryKey = `${RETRY_PREFIX}${domain}`;
	const retryUntil = await redis.get(retryKey);

	if (retryUntil) {
		const remaining = parseInt(retryUntil, 10) - Date.now();
		if (remaining > 0) return remaining;
	}

	return 0;
}

/**
 * Record an SMTP response for a domain and update health classification
 */
export async function recordResponse(
	redis: Redis,
	domain: string,
	code: number,
	enhancedCode?: string
): Promise<void> {
	const hashKey = `${INTEL_PREFIX}${domain}`;
	const now = Date.now();

	// Add to recent codes history
	const record = JSON.stringify({ code, enhancedCode, timestamp: now });
	await redis.lpush(`${hashKey}:codes`, record);
	await redis.ltrim(`${hashKey}:codes`, 0, HISTORY_SIZE - 1);
	await redis.expire(`${hashKey}:codes`, TTL_SECONDS);

	// Increment counters
	const cls = codeClass(code);
	if (cls === '2xx') {
		await redis.hincrby(hashKey, 'total2xx', 1);
	} else if (cls === '4xx') {
		await redis.hincrby(hashKey, 'total4xx', 1);
	} else if (cls === '5xx') {
		await redis.hincrby(hashKey, 'total5xx', 1);
	}
	await redis.hincrby(hashKey, 'totalSent', 1);
	await redis.expire(hashKey, TTL_SECONDS);

	// Analyze recent pattern
	const recentCodes = await redis.lrange(`${hashKey}:codes`, 0, HISTORY_SIZE - 1);
	if (recentCodes.length < 5) return; // Need minimum data

	let count2xx = 0;
	let count4xx = 0;
	let count5xx = 0;

	for (const raw of recentCodes) {
		try {
			const parsed = JSON.parse(raw) as { code: number };
			const parsedClass = codeClass(parsed.code);
			if (parsedClass === '2xx') count2xx++;
			else if (parsedClass === '4xx') count4xx++;
			else if (parsedClass === '5xx') count5xx++;
		} catch {
			continue;
		}
	}

	const total = count2xx + count4xx + count5xx;
	if (total === 0) return;

	const ratio4xx = count4xx / total;
	const ratio5xx = count5xx / total;

	let newStatus: SmtpDomainStatus = 'healthy';

	// Check for blocking pattern (many 5xx)
	if (ratio5xx > BLOCKING_5XX_RATIO && count5xx >= BLOCKING_MIN_RESPONSES) {
		newStatus = 'blocking';
		await redis.set(
			`${RETRY_PREFIX}${domain}`,
			String(now + BLOCKING_DEFER_MS),
			'PX',
			BLOCKING_DEFER_MS
		);
		logger.warn({ domain, ratio5xx, count5xx }, 'Domain marked as blocking');
	}
	// Check for degraded pattern (many 4xx)
	else if (ratio4xx > DEGRADED_4XX_RATIO) {
		// Additional check: last 5 responses all 4xx?
		const lastFive = recentCodes.slice(0, 5);
		const allRecent4xx = lastFive.every((raw) => {
			try {
				const p = JSON.parse(raw) as { code: number };
				return codeClass(p.code) === '4xx';
			} catch {
				return false;
			}
		});

		if (allRecent4xx) {
			newStatus = 'degraded';
			await redis.set(
				`${RETRY_PREFIX}${domain}`,
				String(now + DEGRADED_DEFER_MS),
				'PX',
				DEGRADED_DEFER_MS
			);
			logger.info({ domain, ratio4xx }, 'Domain marked as degraded');
		}
	}

	await redis.hset(hashKey, 'healthStatus', newStatus);
}

/**
 * Get domain health status for monitoring
 */
export async function getDomainHealth(
	redis: Redis,
	domain: string
): Promise<{
	status: SmtpDomainStatus;
	totalSent: number;
	total2xx: number;
	total4xx: number;
	total5xx: number;
} | null> {
	const hashKey = `${INTEL_PREFIX}${domain}`;
	const data = await redis.hgetall(hashKey);
	if (!data['totalSent']) return null;

	return {
		status: (data['healthStatus'] as SmtpDomainStatus) ?? 'healthy',
		totalSent: parseInt(data['totalSent'] ?? '0', 10),
		total2xx: parseInt(data['total2xx'] ?? '0', 10),
		total4xx: parseInt(data['total4xx'] ?? '0', 10),
		total5xx: parseInt(data['total5xx'] ?? '0', 10),
	};
}
