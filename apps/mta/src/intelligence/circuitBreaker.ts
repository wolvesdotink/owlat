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
}> {
	if (provider) {
		const globalResult = await canSend(redis, orgId);
		if (!globalResult.allowed) return globalResult;
	}

	const stateKey = breakerStateKey(orgId, provider);
	const stateData = await redis.hgetall(stateKey);

	if (!stateData['status'] || stateData['status'] === 'closed') {
		return { allowed: true, state: 'closed' };
	}

	const now = Date.now();

	if (stateData['status'] === 'open') {
		const cooldownUntil = parseInt(stateData['cooldownUntil'] ?? '0', 10);
		if (now >= cooldownUntil) {
			// Transition to half-open
			await redis.hset(
				stateKey,
				'status',
				'half-open',
				'halfOpenSent',
				'0',
				'halfOpenBounced',
				'0'
			);
			logger.info({ orgId }, 'Circuit breaker entering half-open');
			return { allowed: true, state: 'half-open' };
		}
		return { allowed: false, retryAfter: cooldownUntil - now, state: 'open' };
	}

	if (stateData['status'] === 'half-open') {
		const halfOpenSent = parseInt(stateData['halfOpenSent'] ?? '0', 10);
		if (halfOpenSent >= HALF_OPEN_LIMIT) {
			// All test sends done and we're still half-open = check results
			const halfOpenBounced = parseInt(stateData['halfOpenBounced'] ?? '0', 10);
			if (halfOpenBounced === 0) {
				// All test sends delivered — close circuit
				await redis.hset(stateKey, 'status', 'closed');
				await redis.del(breakerOutcomesKey(orgId, provider));
				logger.info({ orgId }, 'Circuit breaker closed (recovered)');
				return { allowed: true, state: 'closed' };
			} else {
				// Bounces in test — re-open with extended cooldown
				await redis.hset(
					stateKey,
					'status',
					'open',
					'cooldownUntil',
					String(now + EXTENDED_COOLDOWN_MS),
					'tripReason',
					'Bounce detected during half-open test'
				);
				logger.warn({ orgId, halfOpenBounced }, 'Circuit breaker re-opened from half-open');
				return { allowed: false, retryAfter: EXTENDED_COOLDOWN_MS, state: 'open' };
			}
		}
		return { allowed: true, state: 'half-open' };
	}

	return { allowed: true };
}

function breakerScope(orgId: string, provider?: string): string {
	return provider ? `${orgId}:provider:${provider}` : orgId;
}

function breakerStateKey(orgId: string, provider?: string): string {
	return `${BREAKER_PREFIX}${breakerScope(orgId, provider)}${STATE_SUFFIX}`;
}

function breakerOutcomesKey(orgId: string, provider?: string): string {
	return `${BREAKER_PREFIX}${breakerScope(orgId, provider)}${OUTCOMES_SUFFIX}`;
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
	provider?: string
): Promise<void> {
	if (provider) {
		await recordScopedOutcome(redis, orgId, outcome, undefined, provider);
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
	if (currentStatus === 'half-open') {
		if (outcome === 'bounced' || outcome === 'complained') {
			await redis.hincrby(stateKey, 'halfOpenBounced', 1);
		}
		await redis.hincrby(stateKey, 'halfOpenSent', 1);
		return;
	}

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
			reason
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
