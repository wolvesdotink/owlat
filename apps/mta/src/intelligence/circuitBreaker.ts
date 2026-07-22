/**
 * [3] Real-Time Per-Organization Circuit Breaker
 *
 * Provides fast-acting protection against bad email lists by tracking
 * per-org bounce AND complaint rates in a sliding window. The Convex
 * backend has a 30-day window — this operates in real-time at the MTA level.
 *
 * States:
 * - closed: normal operation
 * - open: sending paused (bounce/complaint rate too high)
 * - half-open: testing with a small number of sends
 *
 * Outcome markers in the ring buffer:
 * - 'd' = delivered
 * - 'b' = bounced
 * - 'c' = complained (spam report)
 */

import type Redis from 'ioredis';
import type { CircuitBreakerState, CircuitState } from '../types.js';
import { notifyConvex } from '../webhooks/convexNotifier.js';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';

const BREAKER_PREFIX = 'mta:breaker:';
const OUTCOMES_SUFFIX = ':outcomes';
const STATE_SUFFIX = ':state';

// Bounce thresholds
export const FAST_WINDOW = 50; // Check after 50 sends
export const FAST_THRESHOLD = 0.15; // >15% bounce rate
export const SLOW_WINDOW = 100; // Check after 100 sends
export const SLOW_THRESHOLD = 0.08; // >8% bounce rate

// Complaint thresholds — complaints are more damaging than bounces
// ISPs blocklist on complaint rates far lower than bounce rates
export const COMPLAINT_FAST_THRESHOLD = 0.04; // >4% complaint rate in last 50 (very early signal)
export const COMPLAINT_SLOW_THRESHOLD = 0.002; // >0.2% complaint rate in last 100 (industry standard)

export const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
export const EXTENDED_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes
export const HALF_OPEN_LIMIT = 5; // Test sends in half-open
const OUTCOME_TTL = 6 * 3600; // 6h TTL for outcome data
const PROBE_TTL_MS = 15 * 60 * 1000;

const RESERVE_PROBE_LUA = `
local stateKey = KEYS[1]
local probeKey = KEYS[2]
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local messageId = ARGV[3]
local expectedGeneration = tonumber(ARGV[4])
if redis.call('HGET', stateKey, 'status') ~= 'half-open' then return 0 end
local generation = tonumber(redis.call('HGET', stateKey, 'generation') or '0')
if expectedGeneration >= 0 and generation ~= expectedGeneration then return 0 end
redis.call('ZREMRANGEBYSCORE', probeKey, '-inf', now)
if redis.call('ZSCORE', probeKey, messageId) then return 1 end
local completed = tonumber(redis.call('HGET', stateKey, 'halfOpenSent') or '0')
local reserved = tonumber(redis.call('ZCARD', probeKey))
if completed + reserved >= ${HALF_OPEN_LIMIT} then return 0 end
redis.call('ZADD', probeKey, expiresAt, messageId)
redis.call('PEXPIRE', probeKey, ${PROBE_TTL_MS + 60_000})
return 1
`;

/** Atomically grant at most HALF_OPEN_LIMIT concurrent owned-IP probes. */
export async function reserveHalfOpenProbe(
	redis: Redis,
	orgId: string,
	provider: string | undefined,
	messageId: string,
	now = Date.now(),
	expectedGeneration = -1
): Promise<boolean> {
	return (
		Number(
			await redis.eval(
				RESERVE_PROBE_LUA,
				2,
				breakerStateKey(orgId, provider),
				breakerProbesKey(orgId, provider),
				now,
				now + PROBE_TTL_MS,
				messageId,
				expectedGeneration
			)
		) === 1
	);
}

const RELEASE_PROBE_LUA = `
if redis.call('HGET', KEYS[1], 'status') ~= 'half-open' then return 0 end
if tonumber(redis.call('HGET', KEYS[1], 'generation') or '0') ~= tonumber(ARGV[2]) then return 0 end
return redis.call('ZREM', KEYS[2], ARGV[1])
`;

export async function releaseHalfOpenProbe(
	redis: Redis,
	orgId: string,
	provider: string | undefined,
	messageId: string,
	generation: number
): Promise<void> {
	await redis.eval(
		RELEASE_PROBE_LUA,
		2,
		breakerStateKey(orgId, provider),
		breakerProbesKey(orgId, provider),
		messageId,
		generation
	);
}

const CONSUME_PROBE_LUA = `
if redis.call('HGET', KEYS[1], 'status') ~= 'half-open' then return 0 end
if tonumber(redis.call('HGET', KEYS[1], 'generation') or '0') ~= tonumber(ARGV[2]) then return 0 end
if redis.call('ZREM', KEYS[2], ARGV[1]) ~= 1 then return 0 end
redis.call('HINCRBY', KEYS[1], 'halfOpenSent', 1)
if ARGV[3] ~= 'delivered' then redis.call('HINCRBY', KEYS[1], 'halfOpenBounced', 1) end
return 1
`;

async function consumeHalfOpenProbe(
	redis: Redis,
	orgId: string,
	provider: string | undefined,
	messageId: string,
	generation: number,
	outcome: 'delivered' | 'bounced' | 'complained'
): Promise<boolean> {
	return (
		Number(
			await redis.eval(
				CONSUME_PROBE_LUA,
				2,
				breakerStateKey(orgId, provider),
				breakerProbesKey(orgId, provider),
				messageId,
				generation,
				outcome
			)
		) === 1
	);
}

/**
 * Check if an organization can send (circuit breaker check)
 *
 * Returns:
 * - { allowed: true } — proceed with sending
 * - { allowed: false, retryAfter } — circuit is open, delay and retry
 */
export async function canSend(
	redis: Redis,
	orgId: string,
	provider?: string
): Promise<{
	allowed: boolean;
	retryAfter?: number;
	state?: CircuitState;
	generation: number;
}> {
	if (provider) {
		const globalResult = await canSend(redis, orgId);
		if (!globalResult.allowed) return globalResult;
	}
	return canSendScope(redis, orgId, provider);
}

/**
 * Check exactly one breaker scope. Callers that already check the global
 * breaker use this for the provider scope so a concurrent global transition
 * can never be mistaken for a provider-only failure and routed to relay.
 */
export async function canSendScope(
	redis: Redis,
	orgId: string,
	provider?: string
): Promise<{
	allowed: boolean;
	retryAfter?: number;
	state?: CircuitState;
	generation: number;
}> {
	const stateKey = breakerStateKey(orgId, provider);
	const stateData = await redis.hgetall(stateKey);

	if (!stateData['status'] || stateData['status'] === 'closed') {
		return { allowed: true, state: 'closed', generation: Number(stateData['generation'] ?? 0) };
	}

	const now = Date.now();

	if (stateData['status'] === 'open') {
		const cooldownUntil = parseInt(stateData['cooldownUntil'] ?? '0', 10);
		if (now >= cooldownUntil) {
			// Transition to half-open
			const generation = Number(stateData['generation'] ?? 0) + 1;
			await redis.hset(
				stateKey,
				'status',
				'half-open',
				'halfOpenSent',
				'0',
				'halfOpenBounced',
				'0',
				'generation',
				String(generation)
			);
			logger.info({ orgId }, 'Circuit breaker entering half-open');
			return { allowed: true, state: 'half-open', generation };
		}
		return {
			allowed: false,
			retryAfter: cooldownUntil - now,
			state: 'open',
			generation: Number(stateData['generation'] ?? 0),
		};
	}

	if (stateData['status'] === 'half-open') {
		const halfOpenSent = parseInt(stateData['halfOpenSent'] ?? '0', 10);
		if (halfOpenSent >= HALF_OPEN_LIMIT) {
			// All test sends done and we're still half-open = check results
			const halfOpenBounced = parseInt(stateData['halfOpenBounced'] ?? '0', 10);
			if (halfOpenBounced === 0) {
				// All test sends delivered — close circuit
				const generation = Number(stateData['generation'] ?? 0) + 1;
				await redis.hset(stateKey, 'status', 'closed', 'generation', String(generation));
				await redis.del(breakerOutcomesKey(orgId, provider));
				logger.info({ orgId }, 'Circuit breaker closed (recovered)');
				return {
					allowed: true,
					state: 'closed',
					generation,
				};
			} else {
				// Bounces in test — re-open with extended cooldown
				const generation = Number(stateData['generation'] ?? 0) + 1;
				await redis.hset(
					stateKey,
					'status',
					'open',
					'cooldownUntil',
					String(now + EXTENDED_COOLDOWN_MS),
					'tripReason',
					'Bounce detected during half-open test',
					'generation',
					String(generation)
				);
				logger.warn({ orgId, halfOpenBounced }, 'Circuit breaker re-opened from half-open');
				return {
					allowed: false,
					retryAfter: EXTENDED_COOLDOWN_MS,
					state: 'open',
					generation,
				};
			}
		}
		return {
			allowed: true,
			state: 'half-open',
			generation: Number(stateData['generation'] ?? 0),
		};
	}

	return { allowed: true, generation: Number(stateData['generation'] ?? 0) };
}

function breakerScope(orgId: string, provider?: string): string {
	return provider ? `${orgId}:provider:${provider}` : orgId;
}

function breakerStateKey(orgId: string, provider?: string): string {
	return `${BREAKER_PREFIX}{${breakerScope(orgId, provider)}}${STATE_SUFFIX}`;
}

function breakerOutcomesKey(orgId: string, provider?: string): string {
	return `${BREAKER_PREFIX}{${breakerScope(orgId, provider)}}${OUTCOMES_SUFFIX}`;
}

function breakerProbesKey(orgId: string, provider?: string): string {
	return `${BREAKER_PREFIX}{${breakerScope(orgId, provider)}}:probes`;
}

/**
 * Record a delivery outcome for an organization.
 *
 * Tracks bounces AND complaints in the same ring buffer.
 * Complaints are weighted more heavily because ISPs blocklist
 * on much lower complaint rates than bounce rates.
 */
export async function recordOutcome(
	redis: Redis,
	orgId: string,
	outcome: 'delivered' | 'bounced' | 'complained',
	config?: MtaConfig,
	provider?: string,
	probeReceipt?: { messageId: string; globalGeneration?: number; providerGeneration?: number }
): Promise<void> {
	if (provider) {
		// Provider-local history powers selective relay fallback, while the
		// organization-wide history remains the dominant abuse guard. Only the
		// global scope receives config so one outcome can emit at most one Convex
		// circuit-breaker notification.
		if (probeReceipt?.providerGeneration !== undefined) {
			await consumeHalfOpenProbe(
				redis,
				orgId,
				provider,
				probeReceipt.messageId,
				probeReceipt.providerGeneration,
				outcome
			);
		} else await recordScopedOutcome(redis, orgId, outcome, undefined, provider);
		if (probeReceipt?.globalGeneration !== undefined) {
			await consumeHalfOpenProbe(
				redis,
				orgId,
				undefined,
				probeReceipt.messageId,
				probeReceipt.globalGeneration,
				outcome
			);
		} else await recordScopedOutcome(redis, orgId, outcome, config);
		return;
	}
	if (probeReceipt?.globalGeneration !== undefined) {
		await consumeHalfOpenProbe(
			redis,
			orgId,
			undefined,
			probeReceipt.messageId,
			probeReceipt.globalGeneration,
			outcome
		);
		return;
	}
	await recordScopedOutcome(redis, orgId, outcome, config);
}

async function recordScopedOutcome(
	redis: Redis,
	orgId: string,
	outcome: 'delivered' | 'bounced' | 'complained',
	config?: MtaConfig,
	provider?: string
): Promise<void> {
	const outcomesKey = breakerOutcomesKey(orgId, provider);
	const stateKey = breakerStateKey(orgId, provider);

	const marker = outcome === 'bounced' ? 'b' : outcome === 'complained' ? 'c' : 'd';

	// Get current state
	const currentStatus = await redis.hget(stateKey, 'status');

	// Handle half-open state tracking
	if (currentStatus === 'half-open') return;

	// Normal tracking: add to ring buffer
	await redis.lpush(outcomesKey, marker);
	await redis.ltrim(outcomesKey, 0, SLOW_WINDOW - 1);
	await redis.expire(outcomesKey, OUTCOME_TTL);

	// Only check thresholds if we're closed
	if (currentStatus === 'open') return;

	// Check thresholds
	const outcomes = await redis.lrange(outcomesKey, 0, SLOW_WINDOW - 1);
	const total = outcomes.length;
	const bounces = outcomes.filter((o) => o === 'b').length;
	const complaints = outcomes.filter((o) => o === 'c').length;

	let shouldTrip = false;
	let reason = '';

	// ── Bounce rate checks ──

	if (total >= FAST_WINDOW) {
		const recentBounces = outcomes.slice(0, FAST_WINDOW).filter((o) => o === 'b').length;
		const recentRate = recentBounces / FAST_WINDOW;
		if (recentRate > FAST_THRESHOLD) {
			shouldTrip = true;
			reason = `Bounce rate ${(recentRate * 100).toFixed(1)}% exceeded ${FAST_THRESHOLD * 100}% threshold in last ${FAST_WINDOW} sends`;
		}
	}

	if (!shouldTrip && total >= SLOW_WINDOW) {
		const bounceRate = bounces / total;
		if (bounceRate > SLOW_THRESHOLD) {
			shouldTrip = true;
			reason = `Bounce rate ${(bounceRate * 100).toFixed(1)}% exceeded ${SLOW_THRESHOLD * 100}% threshold in last ${SLOW_WINDOW} sends`;
		}
	}

	// ── Complaint rate checks ──
	// Complaints are checked with lower thresholds because ISPs (Gmail, Yahoo)
	// penalize senders at much lower complaint rates (~0.3%) than bounce rates

	if (!shouldTrip && total >= FAST_WINDOW) {
		const recentComplaints = outcomes.slice(0, FAST_WINDOW).filter((o) => o === 'c').length;
		const recentRate = recentComplaints / FAST_WINDOW;
		if (recentRate > COMPLAINT_FAST_THRESHOLD) {
			shouldTrip = true;
			reason = `Complaint rate ${(recentRate * 100).toFixed(1)}% exceeded ${COMPLAINT_FAST_THRESHOLD * 100}% threshold in last ${FAST_WINDOW} sends`;
		}
	}

	if (!shouldTrip && total >= SLOW_WINDOW) {
		const complaintRate = complaints / total;
		if (complaintRate > COMPLAINT_SLOW_THRESHOLD) {
			shouldTrip = true;
			reason = `Complaint rate ${(complaintRate * 100).toFixed(2)}% exceeded ${COMPLAINT_SLOW_THRESHOLD * 100}% threshold in last ${SLOW_WINDOW} sends`;
		}
	}

	if (shouldTrip) {
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
		await redis.expire(stateKey, OUTCOME_TTL);

		logger.warn({ orgId, reason }, 'Circuit breaker TRIPPED');

		// Alert Convex
		if (config) {
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
			).catch((err) =>
				logger.error({ err, orgId }, 'Failed to notify Convex of circuit breaker trip')
			);

			logger.info({ orgId, bounceRate, complaintRate, total }, 'Circuit breaker trip details');
		}
	}
}

/**
 * Get circuit breaker state for monitoring
 */
export async function getState(
	redis: Redis,
	orgId: string,
	provider?: string
): Promise<CircuitBreakerState> {
	const stateKey = breakerStateKey(orgId, provider);
	const data = await redis.hgetall(stateKey);

	return {
		status: (data['status'] as CircuitState) ?? 'closed',
		openedAt: data['openedAt'] ? parseInt(data['openedAt'], 10) : undefined,
		cooldownUntil: data['cooldownUntil'] ? parseInt(data['cooldownUntil'], 10) : undefined,
		tripReason: data['tripReason'],
		halfOpenSent: data['halfOpenSent'] ? parseInt(data['halfOpenSent'], 10) : undefined,
		halfOpenBounced: data['halfOpenBounced'] ? parseInt(data['halfOpenBounced'], 10) : undefined,
	};
}
