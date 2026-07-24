import type Redis from 'ioredis';
import {
	DURABLE_EFFECT_IDEMPOTENCY_TTL_MS,
	type DurableEffectIdentity,
} from '../lib/effectCheckpoint.js';
import { warmingDailyStatsKey, warmingOutcomeReceiptKey, warmingStateKey } from './warmingKeys.js';

const RECORD_DAILY_OUTCOME_ONCE_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], 'recorded', 'PX', ARGV[3])
return 1
`;

const RECORD_UNRESERVED_SEND_ONCE_LUA = `
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
redis.call('HINCRBY', KEYS[1], 'sentToday', 1)
redis.call('HINCRBY', KEYS[2], 'sent', 1)
redis.call('EXPIRE', KEYS[2], ARGV[1])
redis.call('SET', KEYS[3], 'recorded', 'PX', ARGV[2])
return 1
`;

export async function recordUnreservedWarmingSendOnce(
	redis: Redis,
	ip: string,
	utcDate: string,
	identity: DurableEffectIdentity
): Promise<void> {
	await redis.eval(
		RECORD_UNRESERVED_SEND_ONCE_LUA,
		3,
		warmingStateKey(ip),
		warmingDailyStatsKey(ip, utcDate),
		warmingOutcomeReceiptKey(ip, identity),
		'172800',
		String(DURABLE_EFFECT_IDEMPOTENCY_TTL_MS)
	);
}

export async function recordDailyWarmingOutcomeOnce(
	redis: Redis,
	ip: string,
	utcDate: string,
	field: 'bounced' | 'deferred',
	identity: DurableEffectIdentity
): Promise<void> {
	await redis.eval(
		RECORD_DAILY_OUTCOME_ONCE_LUA,
		2,
		warmingDailyStatsKey(ip, utcDate),
		warmingOutcomeReceiptKey(ip, identity),
		field,
		'172800',
		String(DURABLE_EFFECT_IDEMPOTENCY_TTL_MS)
	);
}
