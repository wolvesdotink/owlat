/**
 * Webhook Dead Letter Queue.
 *
 * Every mutable datum lives in three Redis structures sharing the same hash
 * tag. Store, claim, settle, capacity eviction, and administrative discard are
 * therefore single-slot Lua transitions on both standalone Redis and Cluster.
 * Raw webhook payloads never survive an index eviction.
 */

import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import type { MtaWebhookEvent } from '../types.js';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';

export const WEBHOOK_DLQ_ENTRIES_KEY = 'mta:{webhook-dlq}:entries';
export const WEBHOOK_DLQ_CREATED_KEY = 'mta:{webhook-dlq}:created';
export const WEBHOOK_DLQ_DUE_KEY = 'mta:{webhook-dlq}:due';

declare const webhookHttpStatusBrand: unique symbol;

export type WebhookHttpStatus = number & { readonly [webhookHttpStatusBrand]: true };

export type WebhookDeliveryFailure =
	| { category: 'transport' }
	| { category: 'deadline_exhausted' }
	| { category: 'unknown' }
	| { category: 'legacy' }
	| { category: 'http'; status: WebhookHttpStatus };

export interface DlqEntry {
	dlqId: string;
	event: MtaWebhookEvent;
	failure: WebhookDeliveryFailure;
	attempts: number;
	createdAt: number;
	lastRetryAt?: number;
	claimVersion?: number;
	claim?: { owner: string; version: number; expiresAt: number; token?: string };
}

export interface ClaimedDlqEntry extends DlqEntry {
	claim: NonNullable<DlqEntry['claim']>;
}

export const WEBHOOK_DLQ_CLAIM_LEASE_MS = 15 * 60 * 1000;
export const WEBHOOK_DLQ_AUTO_RETRY_LIMIT = 8;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

/** The one retry policy used by production and tests. */
export function webhookDlqRetryDelayMs(attempts: number): number {
	return Math.min(60_000 * 2 ** Math.max(0, attempts), MAX_RETRY_DELAY_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isWebhookHttpStatus(value: unknown): value is WebhookHttpStatus {
	return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

export function classifyWebhookHttpFailure(status: number): WebhookDeliveryFailure {
	return isWebhookHttpStatus(status) ? { category: 'http', status } : { category: 'unknown' };
}

function parseDeliveryFailure(value: unknown): WebhookDeliveryFailure | null {
	if (!isRecord(value) || typeof value['category'] !== 'string') return null;
	switch (value['category']) {
		case 'transport':
		case 'deadline_exhausted':
		case 'unknown':
		case 'legacy':
			return { category: value['category'] };
		case 'http':
			return isWebhookHttpStatus(value['status'])
				? { category: 'http', status: value['status'] }
				: null;
		default:
			return null;
	}
}

function parseDlqEntry(data: string): DlqEntry | null {
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		return null;
	}
	if (
		!isRecord(value) ||
		typeof value['dlqId'] !== 'string' ||
		!isRecord(value['event']) ||
		typeof value['event']['event'] !== 'string' ||
		typeof value['event']['timestamp'] !== 'number' ||
		typeof value['attempts'] !== 'number' ||
		typeof value['createdAt'] !== 'number' ||
		(value['lastRetryAt'] !== undefined && typeof value['lastRetryAt'] !== 'number') ||
		(value['claimVersion'] !== undefined && typeof value['claimVersion'] !== 'number')
	) {
		return null;
	}
	const failure =
		parseDeliveryFailure(value['failure']) ??
		(typeof value['error'] === 'string' ? { category: 'legacy' as const } : null);
	if (!failure) return null;
	const claim = isRecord(value['claim'])
		? typeof value['claim']['owner'] === 'string' &&
			typeof value['claim']['version'] === 'number' &&
			Number.isInteger(value['claim']['version']) &&
			typeof value['claim']['expiresAt'] === 'number'
			? {
					owner: value['claim']['owner'],
					version: value['claim']['version'],
					expiresAt: value['claim']['expiresAt'],
				}
			: null
		: null;
	if (value['claim'] !== undefined && !claim) return null;
	return {
		dlqId: value['dlqId'],
		event: value['event'] as unknown as MtaWebhookEvent,
		failure,
		attempts: value['attempts'],
		createdAt: value['createdAt'],
		...(value['lastRetryAt'] === undefined ? {} : { lastRetryAt: value['lastRetryAt'] }),
		...(value['claimVersion'] === undefined ? {} : { claimVersion: value['claimVersion'] }),
		...(claim ? { claim } : {}),
	};
}

const STORE_LUA = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[1], 'attempts:' .. ARGV[1], '0')
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[1])
local excess = redis.call('ZCARD', KEYS[2]) - tonumber(ARGV[5])
if excess > 0 then
  local evicted = redis.call('ZRANGE', KEYS[2], 0, excess - 1)
  for _, id in ipairs(evicted) do
    redis.call('HDEL', KEYS[1], id, 'attempts:' .. id, 'claim:' .. id, 'claim-expiry:' .. id, 'version:' .. id)
    redis.call('ZREM', KEYS[2], id)
    redis.call('ZREM', KEYS[3], id)
  end
end
return 1
`;

const CLAIM_LUA = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return nil end
local now = tonumber(ARGV[3])
local existingClaim = redis.call('HGET', KEYS[1], 'claim:' .. ARGV[1])
if existingClaim then
  local expiresAt = tonumber(redis.call('HGET', KEYS[1], 'claim-expiry:' .. ARGV[1]))
  if expiresAt and expiresAt > now then return nil end
end
local attempts = tonumber(redis.call('HGET', KEYS[1], 'attempts:' .. ARGV[1])) or 0
if ARGV[6] == '1' and attempts >= tonumber(ARGV[7]) then
  redis.call('ZREM', KEYS[3], ARGV[1])
  return nil
end
if ARGV[5] == '1' then
  local due = redis.call('ZSCORE', KEYS[3], ARGV[1])
  if not due or tonumber(due) > now then return nil end
end
local version = redis.call('HINCRBY', KEYS[1], 'version:' .. ARGV[1], 1)
local expiresAt = now + tonumber(ARGV[4])
local token = ARGV[2] .. '|' .. version
redis.call('HSET', KEYS[1], 'claim:' .. ARGV[1], token)
redis.call('HSET', KEYS[1], 'claim-expiry:' .. ARGV[1], tostring(expiresAt))
return { raw, tostring(version), tostring(expiresAt), token }
`;

const SETTLE_LUA = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
if redis.call('HGET', KEYS[1], 'claim:' .. ARGV[1]) ~= ARGV[2] then return 0 end
if ARGV[3] == 'success' then
  redis.call('HDEL', KEYS[1], ARGV[1], 'attempts:' .. ARGV[1], 'claim:' .. ARGV[1], 'claim-expiry:' .. ARGV[1], 'version:' .. ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('ZREM', KEYS[3], ARGV[1])
  return 1
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[4])
redis.call('HSET', KEYS[1], 'attempts:' .. ARGV[1], ARGV[5])
redis.call('HDEL', KEYS[1], 'claim:' .. ARGV[1])
redis.call('HDEL', KEYS[1], 'claim-expiry:' .. ARGV[1])
if ARGV[6] == '' then
  redis.call('ZREM', KEYS[3], ARGV[1])
else
  redis.call('ZADD', KEYS[3], ARGV[6], ARGV[1])
end
return 1
`;

const DISCARD_LUA = `
local removed = redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[1], 'attempts:' .. ARGV[1], 'claim:' .. ARGV[1], 'claim-expiry:' .. ARGV[1], 'version:' .. ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
return removed
`;

const KEYS = [WEBHOOK_DLQ_ENTRIES_KEY, WEBHOOK_DLQ_CREATED_KEY, WEBHOOK_DLQ_DUE_KEY] as const;

export async function storeFailed(
	redis: Redis,
	event: MtaWebhookEvent,
	failure: WebhookDeliveryFailure,
	config: MtaConfig
): Promise<string> {
	const dlqId = randomUUID();
	const createdAt = Date.now();
	const entry: DlqEntry = { dlqId, event, failure, attempts: 0, createdAt };
	await redis.eval(
		STORE_LUA,
		3,
		...KEYS,
		dlqId,
		JSON.stringify(entry),
		String(createdAt),
		String(createdAt + webhookDlqRetryDelayMs(0)),
		String(config.webhookDlqMaxSize)
	);
	logger.warn(
		{ operation: 'convex_webhook_dlq', category: 'stored', eventType: event.event },
		'Webhook event stored in DLQ'
	);
	return dlqId;
}

export async function claimOne(
	redis: Redis,
	dlqId: string,
	options: {
		owner: string;
		now: number;
		leaseMs?: number;
		requireDue: boolean;
		enforceAutoLimit: boolean;
		autoRetryLimit: number;
	}
): Promise<ClaimedDlqEntry | null> {
	const result = (await redis.eval(
		CLAIM_LUA,
		3,
		...KEYS,
		dlqId,
		options.owner,
		String(options.now),
		String(options.leaseMs ?? WEBHOOK_DLQ_CLAIM_LEASE_MS),
		options.requireDue ? '1' : '0',
		options.enforceAutoLimit ? '1' : '0',
		String(options.autoRetryLimit)
	)) as [string, string, string, string] | null;
	if (!result) return null;
	const parsed = parseDlqEntry(result[0]);
	if (!parsed) return null;
	return {
		...parsed,
		claim: {
			owner: options.owner,
			version: Number(result[1]),
			expiresAt: Number(result[2]),
			token: result[3],
		},
	};
}

/** Return due candidates without leasing them; callers claim immediately before I/O. */
export async function listEligibleIds(
	redis: Redis,
	options: { now: number; limit: number; scanLimit?: number }
): Promise<string[]> {
	return await redis.zrangebyscore(
		WEBHOOK_DLQ_DUE_KEY,
		'-inf',
		String(options.now),
		'LIMIT',
		0,
		Math.max(options.limit, options.scanLimit ?? options.limit)
	);
}

export async function settleClaim(
	redis: Redis,
	entry: ClaimedDlqEntry,
	outcome: 'success' | 'failure',
	now: number
): Promise<boolean> {
	const nextAttempts = entry.attempts + 1;
	const nextDue =
		outcome === 'failure' && nextAttempts < WEBHOOK_DLQ_AUTO_RETRY_LIMIT
			? String(now + webhookDlqRetryDelayMs(nextAttempts))
			: '';
	const updatedEntry: DlqEntry = {
		...entry,
		claim: undefined,
		claimVersion: undefined,
		attempts: nextAttempts,
		lastRetryAt: now,
	};
	const claimToken = entry.claim.token ?? `${entry.claim.owner}|${entry.claim.version}`;
	const settled = (await redis.eval(
		SETTLE_LUA,
		3,
		...KEYS,
		entry.dlqId,
		claimToken,
		outcome,
		JSON.stringify(updatedEntry),
		String(nextAttempts),
		nextDue
	)) as number;
	return settled === 1;
}

export async function listFailed(
	redis: Redis,
	limit = 50,
	offset = 0
): Promise<{ entries: DlqEntry[]; total: number }> {
	const total = await redis.zcard(WEBHOOK_DLQ_CREATED_KEY);
	const ids = await redis.zrevrange(WEBHOOK_DLQ_CREATED_KEY, offset, offset + limit - 1);
	const raw = ids.length > 0 ? await redis.hmget(WEBHOOK_DLQ_ENTRIES_KEY, ...ids) : [];
	const entries = raw.flatMap((value) => {
		if (!value) return [];
		const entry = parseDlqEntry(value);
		return entry ? [entry] : [];
	});
	return { entries, total };
}

export async function getEntry(redis: Redis, dlqId: string): Promise<DlqEntry | null> {
	const data = await redis.hget(WEBHOOK_DLQ_ENTRIES_KEY, dlqId);
	return data ? parseDlqEntry(data) : null;
}

export async function removeOne(redis: Redis, dlqId: string): Promise<boolean> {
	const removed = (await redis.eval(DISCARD_LUA, 3, ...KEYS, dlqId)) as number;
	return removed === 1;
}

export async function getStats(redis: Redis): Promise<{
	total: number;
	oldestTimestamp: number | null;
	newestTimestamp: number | null;
}> {
	const total = await redis.zcard(WEBHOOK_DLQ_CREATED_KEY);
	if (total === 0) return { total: 0, oldestTimestamp: null, newestTimestamp: null };
	const [oldest, newest] = await Promise.all([
		redis.zrange(WEBHOOK_DLQ_CREATED_KEY, 0, 0, 'WITHSCORES'),
		redis.zrevrange(WEBHOOK_DLQ_CREATED_KEY, 0, 0, 'WITHSCORES'),
	]);
	return {
		total,
		oldestTimestamp: oldest[1] ? Number(oldest[1]) : null,
		newestTimestamp: newest[1] ? Number(newest[1]) : null,
	};
}

export async function getAllIds(redis: Redis): Promise<string[]> {
	return await redis.zrange(WEBHOOK_DLQ_CREATED_KEY, 0, -1);
}
