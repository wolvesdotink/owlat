/** Single-key complaint reservation and per-effect checkpoint state. */

import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import {
	EffectCheckpointError,
	runLeasedEffect,
	type EffectLeaseOptions,
} from '../lib/effectCheckpoint.js';
import { TransientFeedbackProcessingError } from './transientFeedbackError.js';

const FBL_DEDUP_PREFIX = 'mta:fbl:dedup:';
const FBL_DEDUP_TTL_SECONDS = 7 * 86400;
const FBL_RESERVATION_TTL_SECONDS = 15 * 60;

export interface ComplaintDedupReservation {
	readonly key: string;
	readonly token: string;
}

export type ComplaintDedupResult =
	| { readonly kind: 'completed' }
	| { readonly kind: 'reserved'; readonly reservation: ComplaintDedupReservation };

const RESERVE_COMPLAINT_LUA = `
local keyTypeReply = redis.call('TYPE', KEYS[1])
local keyType = type(keyTypeReply) == 'table' and keyTypeReply['ok'] or keyTypeReply
if keyType == 'none' then
  redis.call('HSET', KEYS[1], 'status', 'reserved', 'token', ARGV[1])
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return 1
end
if keyType == 'string' then return 0 end
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'completed' then return 0 end
if status == 'retryable' then
  redis.call('HSET', KEYS[1], 'status', 'reserved', 'token', ARGV[1])
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return 1
end
return -1
`;

const COMPLETE_COMPLAINT_LUA = `
local keyTypeReply = redis.call('TYPE', KEYS[1])
local keyType = type(keyTypeReply) == 'table' and keyTypeReply['ok'] or keyTypeReply
if keyType == 'string' then return 0 end
if keyType ~= 'hash' then return -1 end
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'completed' then return 0 end
if status == 'reserved' and redis.call('HGET', KEYS[1], 'token') == ARGV[1] then
  redis.call('HSET', KEYS[1], 'status', 'completed')
  redis.call('HDEL', KEYS[1], 'token')
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return 1
end
return -1
`;

const RELEASE_COMPLAINT_LUA = `
local keyTypeReply = redis.call('TYPE', KEYS[1])
local keyType = type(keyTypeReply) == 'table' and keyTypeReply['ok'] or keyTypeReply
if keyType ~= 'hash' then return 0 end
if redis.call('HGET', KEYS[1], 'status') == 'reserved'
  and redis.call('HGET', KEYS[1], 'token') == ARGV[1] then
  redis.call('HSET', KEYS[1], 'status', 'retryable')
  redis.call('HDEL', KEYS[1], 'token')
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

const BEGIN_EFFECT_LUA = `
local keyTypeReply = redis.call('TYPE', KEYS[1])
local keyType = type(keyTypeReply) == 'table' and keyTypeReply['ok'] or keyTypeReply
if keyType ~= 'hash'
  or redis.call('HGET', KEYS[1], 'status') ~= 'reserved'
  or redis.call('HGET', KEYS[1], 'token') ~= ARGV[1] then return {-1, ''} end
local field = 'effect:' .. ARGV[2]
local state = redis.call('HGET', KEYS[1], field)
if state == 'applied' then return {0, ''} end
if state then
  local _, _, pendingToken, expiresAt = string.find(state, '^pending:([^:]+):([%d%.]+)$')
  local parsedExpiry = tonumber(expiresAt)
  if pendingToken and parsedExpiry and parsedExpiry > 0 and parsedExpiry > tonumber(ARGV[3]) then
    if pendingToken == ARGV[4] then return {1, expiresAt} end
    return {2, expiresAt}
  end
end
local expiresAt = tonumber(ARGV[3]) + tonumber(ARGV[5])
redis.call('HSET', KEYS[1], field, 'pending:' .. ARGV[4] .. ':' .. expiresAt)
return {1, tostring(expiresAt)}
`;

const RENEW_EFFECT_LUA = `
local keyTypeReply = redis.call('TYPE', KEYS[1])
local keyType = type(keyTypeReply) == 'table' and keyTypeReply['ok'] or keyTypeReply
if keyType ~= 'hash'
  or redis.call('HGET', KEYS[1], 'status') ~= 'reserved'
  or redis.call('HGET', KEYS[1], 'token') ~= ARGV[1] then return -1 end
local field = 'effect:' .. ARGV[2]
local state = redis.call('HGET', KEYS[1], field)
local _, _, pendingToken = string.find(state or '', '^pending:([^:]+):[%d%.]+$')
if pendingToken ~= ARGV[3] then return -1 end
local expiresAt = tonumber(ARGV[4]) + tonumber(ARGV[5])
redis.call('HSET', KEYS[1], field, 'pending:' .. ARGV[3] .. ':' .. expiresAt)
return expiresAt
`;

const COMPLETE_EFFECT_LUA = `
local keyTypeReply = redis.call('TYPE', KEYS[1])
local keyType = type(keyTypeReply) == 'table' and keyTypeReply['ok'] or keyTypeReply
if keyType ~= 'hash'
  or redis.call('HGET', KEYS[1], 'status') ~= 'reserved'
  or redis.call('HGET', KEYS[1], 'token') ~= ARGV[1] then return -1 end
local field = 'effect:' .. ARGV[2]
local state = redis.call('HGET', KEYS[1], field)
local _, _, pendingToken = string.find(state or '', '^pending:([^:]+):[%d%.]+$')
if pendingToken ~= ARGV[3] then return -1 end
redis.call('HSET', KEYS[1], field, 'applied')
return 1
`;

const RELEASE_EFFECT_LUA = `
local keyTypeReply = redis.call('TYPE', KEYS[1])
local keyType = type(keyTypeReply) == 'table' and keyTypeReply['ok'] or keyTypeReply
if keyType ~= 'hash'
  or redis.call('HGET', KEYS[1], 'status') ~= 'reserved'
  or redis.call('HGET', KEYS[1], 'token') ~= ARGV[1] then return -1 end
local field = 'effect:' .. ARGV[2]
local state = redis.call('HGET', KEYS[1], field)
local _, _, pendingToken = string.find(state or '', '^pending:([^:]+):[%d%.]+$')
if pendingToken ~= ARGV[3] then return -1 end
redis.call('HDEL', KEYS[1], field)
return 1
`;

export async function reserveComplaint(
	redis: Redis,
	dedupKey: string
): Promise<ComplaintDedupResult> {
	const key = `${FBL_DEDUP_PREFIX}${dedupKey}`;
	const token = `reserved:${randomUUID()}`;
	let status: number;
	try {
		status = (await redis.eval(
			RESERVE_COMPLAINT_LUA,
			1,
			key,
			token,
			String(FBL_RESERVATION_TTL_SECONDS)
		)) as number;
	} catch (error) {
		throw new TransientFeedbackProcessingError('Complaint deduplication is unavailable', error);
	}
	if (status === 0) return { kind: 'completed' };
	if (status === 1) return { kind: 'reserved', reservation: { key, token } };
	throw new TransientFeedbackProcessingError(
		'Complaint processing is already in progress',
		new Error('FBL reservation is held by another intake')
	);
}

export async function completeComplaint(
	redis: Redis,
	reservation: ComplaintDedupReservation
): Promise<void> {
	let status: number;
	try {
		status = (await redis.eval(
			COMPLETE_COMPLAINT_LUA,
			1,
			reservation.key,
			reservation.token,
			String(FBL_DEDUP_TTL_SECONDS)
		)) as number;
	} catch (error) {
		throw new TransientFeedbackProcessingError(
			'Complaint deduplication completion is unavailable',
			error
		);
	}
	if (status < 0) {
		throw new TransientFeedbackProcessingError(
			'Complaint reservation expired before completion',
			new Error('FBL reservation ownership was lost')
		);
	}
}

export async function releaseComplaint(
	redis: Redis,
	reservation: ComplaintDedupReservation
): Promise<void> {
	await redis.eval(
		RELEASE_COMPLAINT_LUA,
		1,
		reservation.key,
		reservation.token,
		String(FBL_DEDUP_TTL_SECONDS)
	);
}

export async function runComplaintEffect<T>(
	redis: Redis,
	reservation: ComplaintDedupReservation,
	effectIdentity: string,
	apply: () => Promise<T>,
	options: EffectLeaseOptions = {}
): Promise<T | undefined> {
	try {
		return await runLeasedEffect(
			{
				begin: async (token, now, leaseMs) => {
					const started = await checkpointResult(
						redis.eval(
							BEGIN_EFFECT_LUA,
							1,
							reservation.key,
							reservation.token,
							effectIdentity,
							String(now),
							token,
							String(leaseMs)
						) as Promise<[number, string]>,
						'complaint effect checkpoint could not be started'
					);
					if (started[0] < 0) {
						throw new EffectCheckpointError('complaint reservation owner changed');
					}
					if (started[0] === 0) return { kind: 'applied' };
					if (started[0] === 1) return { kind: 'acquired' };
					return complaintBusyLease(Number(started[1]));
				},
				renew: async (token, now, leaseMs) => {
					const renewed = await checkpointResult(
						redis.eval(
							RENEW_EFFECT_LUA,
							1,
							reservation.key,
							reservation.token,
							effectIdentity,
							token,
							String(now),
							String(leaseMs)
						) as Promise<number>,
						'complaint effect checkpoint could not be renewed'
					);
					if (renewed < 0) {
						throw new EffectCheckpointError('complaint effect lease owner changed');
					}
				},
				complete: async (token) => {
					const completed = await checkpointResult(
						redis.eval(
							COMPLETE_EFFECT_LUA,
							1,
							reservation.key,
							reservation.token,
							effectIdentity,
							token
						) as Promise<number>,
						'complaint effect checkpoint could not be completed'
					);
					if (completed < 0) {
						throw new EffectCheckpointError('complaint effect lease owner changed');
					}
				},
				release: async (token) => {
					const released = await checkpointResult(
						redis.eval(
							RELEASE_EFFECT_LUA,
							1,
							reservation.key,
							reservation.token,
							effectIdentity,
							token
						) as Promise<number>,
						'complaint effect checkpoint could not be released'
					);
					if (released < 0) {
						throw new EffectCheckpointError('complaint effect lease owner changed');
					}
				},
			},
			apply,
			options
		);
	} catch (error) {
		if (!(error instanceof EffectCheckpointError)) throw error;
		throw new TransientFeedbackProcessingError('Complaint effect checkpoint is unavailable', error);
	}
}

async function checkpointResult<T>(operation: Promise<T>, message: string): Promise<T> {
	try {
		return await operation;
	} catch (error) {
		throw new EffectCheckpointError(message, error);
	}
}

function complaintBusyLease(expiresAt: number) {
	if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
		throw new EffectCheckpointError('complaint effect lease expiry is invalid');
	}
	return { kind: 'busy' as const, expiresAt };
}
