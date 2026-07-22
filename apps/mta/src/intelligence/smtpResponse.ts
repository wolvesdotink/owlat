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
import { createHash } from 'crypto';
import {
	DURABLE_EFFECT_IDEMPOTENCY_TTL_MS,
	type DurableEffectIdentity,
} from '../lib/effectCheckpoint.js';

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

function smtpResponseSlot(domain: string): string {
	return createHash('sha256').update(domain).digest('hex');
}

export function smtpResponseStateKey(domain: string): string {
	return `${INTEL_PREFIX}{${smtpResponseSlot(domain)}}:state`;
}

export function smtpResponseRetryKey(domain: string): string {
	return `${RETRY_PREFIX}{${smtpResponseSlot(domain)}}:until`;
}

function smtpResponseCodesKey(domain: string): string {
	return `${INTEL_PREFIX}{${smtpResponseSlot(domain)}}:codes`;
}

function smtpResponseReceiptKey(domain: string, identity: DurableEffectIdentity): string {
	return `${INTEL_PREFIX}{${smtpResponseSlot(domain)}}:effect:${createHash('sha256').update(identity).digest('hex')}`;
}

const RECORD_RESPONSE_ONCE_LUA = `
local recordedAt = redis.call('GET', KEYS[3])
if recordedAt then return {0, recordedAt, '', 0, 0, 0} end
redis.call('LPUSH', KEYS[2], ARGV[1])
redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[2]) - 1)
redis.call('EXPIRE', KEYS[2], ARGV[3])
if ARGV[4] ~= '' then redis.call('HINCRBY', KEYS[1], ARGV[4], 1) end
redis.call('HINCRBY', KEYS[1], 'totalSent', 1)
redis.call('EXPIRE', KEYS[1], ARGV[3])

local codes = redis.call('LRANGE', KEYS[2], 0, tonumber(ARGV[2]) - 1)
local count2xx = 0
local count4xx = 0
local count5xx = 0
local allRecent4xx = #codes >= 5
for index, raw in ipairs(codes) do
  local responseCode = tonumber(string.match(raw, '"code":(%d+)'))
  if responseCode and responseCode >= 200 and responseCode < 300 then count2xx = count2xx + 1 end
  if responseCode and responseCode >= 400 and responseCode < 500 then count4xx = count4xx + 1 end
  if responseCode and responseCode >= 500 and responseCode < 600 then count5xx = count5xx + 1 end
  if index <= 5 and (not responseCode or responseCode < 400 or responseCode >= 500) then
    allRecent4xx = false
  end
end

local total = count2xx + count4xx + count5xx
local status = ''
if #codes >= 5 and total > 0 then
  status = 'healthy'
  local ratio4xx = count4xx / total
  local ratio5xx = count5xx / total
  if ratio5xx > tonumber(ARGV[7]) and count5xx >= tonumber(ARGV[8]) then
    status = 'blocking'
    local deadline = tonumber(ARGV[6]) + tonumber(ARGV[10])
    redis.call('SET', KEYS[4], tostring(deadline), 'PX', ARGV[10])
  elseif ratio4xx > tonumber(ARGV[9]) and allRecent4xx then
    status = 'degraded'
    local deadline = tonumber(ARGV[6]) + tonumber(ARGV[11])
    redis.call('SET', KEYS[4], tostring(deadline), 'PX', ARGV[11])
  end
  redis.call('HSET', KEYS[1], 'healthStatus', status)
end

redis.call('SET', KEYS[3], ARGV[6], 'PX', ARGV[5])
return {1, ARGV[6], status, count4xx, count5xx, total}
`;

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
	const retryKey = smtpResponseRetryKey(domain);
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
	enhancedCode?: string,
	idempotencyIdentity?: DurableEffectIdentity
): Promise<void> {
	const hashKey = smtpResponseStateKey(domain);
	const codesKey = smtpResponseCodesKey(domain);
	const now = Date.now();

	// Add to recent codes history
	const record = JSON.stringify({ code, enhancedCode, timestamp: now });
	const cls = codeClass(code);
	if (idempotencyIdentity) {
		const result = (await redis.eval(
			RECORD_RESPONSE_ONCE_LUA,
			4,
			hashKey,
			codesKey,
			smtpResponseReceiptKey(domain, idempotencyIdentity),
			smtpResponseRetryKey(domain),
			record,
			String(HISTORY_SIZE),
			String(TTL_SECONDS),
			cls === 'other' ? '' : `total${cls}`,
			String(DURABLE_EFFECT_IDEMPOTENCY_TTL_MS),
			String(now),
			String(BLOCKING_5XX_RATIO),
			String(BLOCKING_MIN_RESPONSES),
			String(DEGRADED_4XX_RATIO),
			String(BLOCKING_DEFER_MS),
			String(DEGRADED_DEFER_MS)
		)) as [number, string, SmtpDomainStatus | '', number, number, number];
		if (Number(result[0]) === 1 && result[2] === 'blocking') {
			logger.warn(
				{ domain, ratio5xx: Number(result[4]) / Number(result[5]), count5xx: Number(result[4]) },
				'Domain marked as blocking'
			);
		} else if (Number(result[0]) === 1 && result[2] === 'degraded') {
			logger.info(
				{ domain, ratio4xx: Number(result[3]) / Number(result[5]) },
				'Domain marked as degraded'
			);
		}
		return;
	} else {
		await redis.lpush(codesKey, record);
		await redis.ltrim(codesKey, 0, HISTORY_SIZE - 1);
		await redis.expire(codesKey, TTL_SECONDS);
		if (cls === '2xx') {
			await redis.hincrby(hashKey, 'total2xx', 1);
		} else if (cls === '4xx') {
			await redis.hincrby(hashKey, 'total4xx', 1);
		} else if (cls === '5xx') {
			await redis.hincrby(hashKey, 'total5xx', 1);
		}
		await redis.hincrby(hashKey, 'totalSent', 1);
		await redis.expire(hashKey, TTL_SECONDS);
	}

	// Analyze recent pattern
	const recentCodes = await redis.lrange(codesKey, 0, HISTORY_SIZE - 1);
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
			smtpResponseRetryKey(domain),
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
				smtpResponseRetryKey(domain),
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
	const hashKey = smtpResponseStateKey(domain);
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
