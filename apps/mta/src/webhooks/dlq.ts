/**
 * Webhook Dead Letter Queue.
 *
 * Every mutable datum lives in four Redis structures sharing the same hash
 * tag. Store, claim, settle, capacity eviction, and administrative discard are
 * therefore single-slot Lua transitions on both standalone Redis and Cluster.
 * Raw webhook payloads never survive an index eviction.
 */

import { createHash, randomUUID } from 'crypto';
import type Redis from 'ioredis';
import type { MtaWebhookEvent } from '../types.js';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { parseDeliveryFailure, type WebhookDeliveryFailure } from './dlqFailure.js';
import { webhookDlqRetryDelayMs } from './dlqRetryPolicy.js';

export {
	classifyWebhookHttpFailure,
	type WebhookDeliveryFailure,
	type WebhookHttpStatus,
} from './dlqFailure.js';
export { webhookDlqRetryDelayMs } from './dlqRetryPolicy.js';

export const WEBHOOK_DLQ_ENTRIES_KEY = 'mta:{webhook-dlq}:entries';
export const WEBHOOK_DLQ_CREATED_KEY = 'mta:{webhook-dlq}:created';
export const WEBHOOK_DLQ_DUE_KEY = 'mta:{webhook-dlq}:due';
export const WEBHOOK_DLQ_PROTECTED_KEY = 'mta:{webhook-dlq}:protected';

export interface DlqEntry {
	dlqId: string;
	event: MtaWebhookEvent;
	failure: WebhookDeliveryFailure;
	attempts: number;
	createdAt: number;
	lastRetryAt?: number;
	claim?: { owner: string; version: number; expiresAt: number; token?: string };
}

export interface ClaimedDlqEntry extends DlqEntry {
	claim: NonNullable<DlqEntry['claim']>;
}

export const WEBHOOK_DLQ_CLAIM_LEASE_MS = 15 * 60 * 1000;
export const WEBHOOK_DLQ_AUTO_RETRY_LIMIT = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
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
		(value['lastRetryAt'] !== undefined && typeof value['lastRetryAt'] !== 'number')
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
		...(claim ? { claim } : {}),
	};
}

const STORE_LUA = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 0 end
if ARGV[5] == '0' and redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then return -1 end
local sequence = redis.call('HINCRBY', KEYS[1], '_created-sequence', 1)
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[1], 'attempts:' .. ARGV[1], '0')
redis.call('ZADD', KEYS[2], sequence, ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
if ARGV[6] == '1' then redis.call('SADD', KEYS[4], ARGV[1]) end
local excess = redis.call('ZCARD', KEYS[2]) - tonumber(ARGV[4])
local insertedRetained = 1
if excess > 0 then
  local candidates = redis.call('ZRANGE', KEYS[2], 0, -1)
  for _, id in ipairs(candidates) do
    if excess <= 0 then break end
    if redis.call('SISMEMBER', KEYS[4], id) == 0 then
      redis.call('HDEL', KEYS[1], id, 'attempts:' .. id, 'claim:' .. id, 'claim-expiry:' .. id, 'version:' .. id)
      redis.call('ZREM', KEYS[2], id)
      redis.call('ZREM', KEYS[3], id)
      if id == ARGV[1] then insertedRetained = 0 end
      excess = excess - 1
    end
  end
end
if insertedRetained == 0 then return -2 end
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
  redis.call('SREM', KEYS[4], ARGV[1])
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
redis.call('SREM', KEYS[4], ARGV[1])
return removed
`;

const QUARANTINE_LUA = `
local quarantined = 0
for i = 1, #ARGV, 3 do
  local id = ARGV[i]
  local expected = ARGV[i + 1]
  local expectedClaim = ARGV[i + 2]
  local currentClaim = redis.call('HGET', KEYS[1], 'claim:' .. id)
  local ownsClaim = (expectedClaim == '' and not currentClaim) or currentClaim == expectedClaim
  if redis.call('HGET', KEYS[1], id) == expected and ownsClaim then
    redis.call('HDEL', KEYS[1], 'claim:' .. id, 'claim-expiry:' .. id, 'version:' .. id)
    redis.call('ZREM', KEYS[3], id)
    quarantined = quarantined + 1
  end
end
return quarantined
`;

const REMOVE_MISSING_DUE_LUA = `
local removed = 0
for _, id in ipairs(ARGV) do
  if redis.call('HEXISTS', KEYS[1], id) == 0 and not redis.call('HGET', KEYS[1], 'claim:' .. id) then
    removed = removed + redis.call('ZREM', KEYS[3], id)
  end
end
return removed
`;

const REMOVE_EXHAUSTED_DUE_LUA = `
local removed = 0
for i = 1, #ARGV, 2 do
  local id = ARGV[i]
  local expected = ARGV[i + 1]
  if redis.call('HGET', KEYS[1], id) == expected then
    removed = removed + redis.call('ZREM', KEYS[3], id)
  end
end
return removed
`;

const KEYS = [
	WEBHOOK_DLQ_ENTRIES_KEY,
	WEBHOOK_DLQ_CREATED_KEY,
	WEBHOOK_DLQ_DUE_KEY,
	WEBHOOK_DLQ_PROTECTED_KEY,
] as const;

async function store(
	redis: Redis,
	dlqId: string,
	event: MtaWebhookEvent,
	failure: WebhookDeliveryFailure,
	config: MtaConfig,
	dueAt: number,
	allowEviction: boolean,
	isProtected: boolean
): Promise<{ dlqId: string; inserted: boolean }> {
	const createdAt = Date.now();
	const entry: DlqEntry = { dlqId, event, failure, attempts: 0, createdAt };
	const status = (await redis.eval(
		STORE_LUA,
		4,
		...KEYS,
		dlqId,
		JSON.stringify(entry),
		String(dueAt),
		String(config.webhookDlqMaxSize),
		allowEviction ? '1' : '0',
		isProtected ? '1' : '0'
	)) as number;
	if (status === -1) throw new Error('Webhook terminal outbox is at capacity');
	if (status === -2) throw new Error('Webhook DLQ is at protected capacity');
	return { dlqId, inserted: status === 1 };
}

export async function storeFailed(
	redis: Redis,
	event: MtaWebhookEvent,
	failure: WebhookDeliveryFailure,
	config: MtaConfig
): Promise<string> {
	const createdAt = Date.now();
	const { dlqId } = await store(
		redis,
		randomUUID(),
		event,
		failure,
		config,
		createdAt + webhookDlqRetryDelayMs(0),
		true,
		false
	);
	logger.warn(
		{ operation: 'convex_webhook_dlq', category: 'stored', eventType: event.event },
		'Webhook event stored in DLQ'
	);
	return dlqId;
}

/** Persist an idempotent webhook outbox row before the owning queue job ACKs. */
export async function storePending(
	redis: Redis,
	event: MtaWebhookEvent,
	config: MtaConfig,
	idempotencyKey: string
): Promise<string> {
	const dlqId = `outbox-${createHash('sha256').update(idempotencyKey).digest('hex')}`;
	await store(redis, dlqId, event, { category: 'pending' }, config, Date.now(), false, true);
	if (!(await getEntry(redis, dlqId))) {
		throw new Error('Webhook terminal outbox persistence could not be verified');
	}
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
		4,
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
	if (!parsed) {
		await redis.eval(QUARANTINE_LUA, 4, ...KEYS, dlqId, result[0], result[3]);
		return null;
	}
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
	options: { now: number; limit: number; scanLimit?: number; autoRetryLimit?: number }
): Promise<string[]> {
	const ids = await redis.zrangebyscore(
		WEBHOOK_DLQ_DUE_KEY,
		'-inf',
		String(options.now),
		'LIMIT',
		0,
		Math.max(options.limit, options.scanLimit ?? options.limit)
	);
	if (ids.length === 0) return [];
	const [raws, claims, claimExpiries] = await Promise.all([
		redis.hmget(WEBHOOK_DLQ_ENTRIES_KEY, ...ids),
		redis.hmget(WEBHOOK_DLQ_ENTRIES_KEY, ...ids.map((id) => `claim:${id}`)),
		redis.hmget(WEBHOOK_DLQ_ENTRIES_KEY, ...ids.map((id) => `claim-expiry:${id}`)),
	]);
	const corrupt: string[] = [];
	const exhausted: string[] = [];
	const valid: string[] = [];
	const missing: string[] = [];
	for (let index = 0; index < ids.length; index++) {
		const raw = raws[index];
		const parsed = raw ? parseDlqEntry(raw) : null;
		if (
			raw &&
			parsed &&
			options.autoRetryLimit !== undefined &&
			parsed.attempts >= options.autoRetryLimit
		) {
			exhausted.push(ids[index]!, raw);
		} else if (parsed) valid.push(ids[index]!);
		else if (raw) {
			const claim = claims[index];
			const expiry = Number(claimExpiries[index]);
			if (!claim || !Number.isFinite(expiry) || expiry <= options.now) {
				corrupt.push(ids[index]!, raw, claim ?? '');
			}
		} else missing.push(ids[index]!);
	}
	if (corrupt.length > 0) await redis.eval(QUARANTINE_LUA, 4, ...KEYS, ...corrupt);
	if (missing.length > 0) await redis.eval(REMOVE_MISSING_DUE_LUA, 4, ...KEYS, ...missing);
	if (exhausted.length > 0) {
		await redis.eval(REMOVE_EXHAUSTED_DUE_LUA, 4, ...KEYS, ...exhausted);
	}
	return valid;
}

export async function settleClaim(
	redis: Redis,
	entry: ClaimedDlqEntry,
	outcome: 'success' | 'failure',
	now: number,
	failure?: WebhookDeliveryFailure
): Promise<boolean> {
	const nextAttempts = entry.attempts + 1;
	const nextDue =
		outcome === 'failure' && nextAttempts < WEBHOOK_DLQ_AUTO_RETRY_LIMIT
			? String(now + webhookDlqRetryDelayMs(nextAttempts))
			: '';
	const updatedEntry: DlqEntry = {
		...entry,
		...(failure ? { failure } : {}),
		claim: undefined,
		attempts: nextAttempts,
		lastRetryAt: now,
	};
	const claimToken = entry.claim.token ?? `${entry.claim.owner}|${entry.claim.version}`;
	const settled = (await redis.eval(
		SETTLE_LUA,
		4,
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
	const removed = (await redis.eval(DISCARD_LUA, 4, ...KEYS, dlqId)) as number;
	return removed === 1;
}

export async function getStats(redis: Redis): Promise<{
	total: number;
	oldestTimestamp: number | null;
	newestTimestamp: number | null;
}> {
	const total = await redis.zcard(WEBHOOK_DLQ_CREATED_KEY);
	if (total === 0) return { total: 0, oldestTimestamp: null, newestTimestamp: null };
	const [oldestIds, newestIds] = await Promise.all([
		redis.zrange(WEBHOOK_DLQ_CREATED_KEY, 0, 0),
		redis.zrevrange(WEBHOOK_DLQ_CREATED_KEY, 0, 0),
	]);
	const [oldest, newest] = await redis.hmget(WEBHOOK_DLQ_ENTRIES_KEY, oldestIds[0]!, newestIds[0]!);
	return {
		total,
		oldestTimestamp: oldest ? (parseDlqEntry(oldest)?.createdAt ?? null) : null,
		newestTimestamp: newest ? (parseDlqEntry(newest)?.createdAt ?? null) : null,
	};
}

export async function getAllIds(redis: Redis): Promise<string[]> {
	return await redis.zrange(WEBHOOK_DLQ_CREATED_KEY, 0, -1);
}
