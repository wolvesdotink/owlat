/** Atomic idempotent persistence for circuit-breaker outcome markers. */

import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import {
	DURABLE_EFFECT_IDEMPOTENCY_TTL_MS,
	type DurableEffectIdentity,
} from '../lib/effectCheckpoint.js';
import { logger } from '../monitoring/logger.js';
import { notifyConvex } from '../webhooks/convexNotifier.js';

const BREAKER_PREFIX = 'mta:breaker:';
const OUTCOMES_SUFFIX = ':outcomes';
const OUTCOME_EFFECTS_SUFFIX = ':outcome-effects';

export const FAST_WINDOW = 50;
export const FAST_THRESHOLD = 0.15;
export const SLOW_WINDOW = 100;
export const SLOW_THRESHOLD = 0.08;
export const COMPLAINT_FAST_THRESHOLD = 0.04;
export const COMPLAINT_SLOW_THRESHOLD = 0.002;
export const COOLDOWN_MS = 30 * 60 * 1000;
const OUTCOME_TTL_SECONDS = 6 * 3600;

const RECORD_OUTCOME_ONCE_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', tonumber(ARGV[2]) - tonumber(ARGV[3]))
local inserted = redis.call('ZADD', KEYS[2], 'NX', ARGV[2], ARGV[1])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
if inserted == 0 then return 0 end
redis.call('LPUSH', KEYS[1], ARGV[5])
redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[6]) - 1)
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
`;

export function circuitBreakerOutcomesKey(scope: string): string {
	return `${BREAKER_PREFIX}{${scope}}${OUTCOMES_SUFFIX}`;
}

function circuitBreakerStateKey(scope: string): string {
	return `${BREAKER_PREFIX}{${scope}}:state`;
}

export async function appendCircuitBreakerOutcome(
	redis: Redis,
	scope: string,
	marker: 'b' | 'c' | 'd',
	options: {
		readonly ttlSeconds: number;
		readonly maxOutcomes: number;
		readonly idempotencyIdentity?: DurableEffectIdentity;
	}
): Promise<void> {
	const outcomesKey = circuitBreakerOutcomesKey(scope);
	if (!options.idempotencyIdentity) {
		await redis.lpush(outcomesKey, marker);
		await redis.ltrim(outcomesKey, 0, options.maxOutcomes - 1);
		await redis.expire(outcomesKey, options.ttlSeconds);
		return;
	}
	await redis.eval(
		RECORD_OUTCOME_ONCE_LUA,
		2,
		outcomesKey,
		`${BREAKER_PREFIX}{${scope}}${OUTCOME_EFFECTS_SUFFIX}`,
		options.idempotencyIdentity,
		String(Date.now()),
		String(DURABLE_EFFECT_IDEMPOTENCY_TTL_MS),
		String(options.ttlSeconds),
		marker,
		String(options.maxOutcomes)
	);
}

export async function recordCircuitBreakerOutcome(
	redis: Redis,
	scope: string,
	orgId: string,
	outcome: 'delivered' | 'bounced' | 'complained',
	config?: MtaConfig,
	idempotencyIdentity?: DurableEffectIdentity
): Promise<void> {
	const outcomesKey = circuitBreakerOutcomesKey(scope);
	const stateKey = circuitBreakerStateKey(scope);
	const marker = outcome === 'bounced' ? 'b' : outcome === 'complained' ? 'c' : 'd';
	const currentStatus = await redis.hget(stateKey, 'status');
	if (currentStatus === 'half-open') return;

	// A duplicate still evaluates thresholds: the first response may have been
	// lost after Redis committed the append but before the caller observed it.
	await appendCircuitBreakerOutcome(redis, scope, marker, {
		ttlSeconds: OUTCOME_TTL_SECONDS,
		maxOutcomes: SLOW_WINDOW,
		idempotencyIdentity,
	});
	if (currentStatus === 'open') return;

	const outcomes = await redis.lrange(outcomesKey, 0, SLOW_WINDOW - 1);
	const total = outcomes.length;
	const bounces = outcomes.filter((item) => item === 'b').length;
	const complaints = outcomes.filter((item) => item === 'c').length;
	const reason = thresholdViolation(outcomes, bounces, complaints);
	if (!reason) return;

	const now = Date.now();
	await redis.hset(
		stateKey,
		'status',
		'open',
		'openedAt',
		String(now),
		'cooldownUntil',
		String(now + COOLDOWN_MS),
		'tripReason',
		reason,
		'generation',
		String(Number((await redis.hget(stateKey, 'generation')) ?? 0) + 1)
	);
	await redis.expire(stateKey, OUTCOME_TTL_SECONDS);
	logger.warn({ orgId, reason }, 'Circuit breaker TRIPPED');

	if (!config) return;
	const bounceRate = bounces / total;
	const complaintRate = complaints / total;
	notifyConvex(
		{
			event: 'org.circuit_breaker',
			organizationId: orgId,
			bounceRate,
			message: reason,
			severity: 'critical',
			timestamp: now,
		},
		config,
		redis
	).catch((error) =>
		logger.error({ err: error, orgId }, 'Failed to notify Convex of circuit breaker trip')
	);
	logger.info({ orgId, bounceRate, complaintRate, total }, 'Circuit breaker trip details');
}

function thresholdViolation(
	outcomes: string[],
	bounces: number,
	complaints: number
): string | undefined {
	const total = outcomes.length;
	if (total >= FAST_WINDOW) {
		const rate = outcomes.slice(0, FAST_WINDOW).filter((item) => item === 'b').length / FAST_WINDOW;
		if (rate > FAST_THRESHOLD)
			return `Bounce rate ${(rate * 100).toFixed(1)}% exceeded ${FAST_THRESHOLD * 100}% threshold in last ${FAST_WINDOW} sends`;
	}
	if (total >= SLOW_WINDOW) {
		const rate = bounces / total;
		if (rate > SLOW_THRESHOLD)
			return `Bounce rate ${(rate * 100).toFixed(1)}% exceeded ${SLOW_THRESHOLD * 100}% threshold in last ${SLOW_WINDOW} sends`;
	}
	if (total >= FAST_WINDOW) {
		const rate = outcomes.slice(0, FAST_WINDOW).filter((item) => item === 'c').length / FAST_WINDOW;
		if (rate > COMPLAINT_FAST_THRESHOLD)
			return `Complaint rate ${(rate * 100).toFixed(1)}% exceeded ${COMPLAINT_FAST_THRESHOLD * 100}% threshold in last ${FAST_WINDOW} sends`;
	}
	if (total >= SLOW_WINDOW) {
		const rate = complaints / total;
		if (rate > COMPLAINT_SLOW_THRESHOLD)
			return `Complaint rate ${(rate * 100).toFixed(2)}% exceeded ${COMPLAINT_SLOW_THRESHOLD * 100}% threshold in last ${SLOW_WINDOW} sends`;
	}
	return undefined;
}
