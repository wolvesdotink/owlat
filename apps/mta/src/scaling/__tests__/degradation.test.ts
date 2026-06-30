import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';
import {
	checkSystemHealth,
	shouldBackoffDomain,
	recordDomainFailure,
	clearDomainFailure,
} from '../degradation.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../redis.js', () => ({
	isRedisHealthy: vi.fn(),
}));

import { isRedisHealthy } from '../../redis.js';
const mockIsRedisHealthy = vi.mocked(isRedisHealthy);

describe('degradation', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(() => {
		redis = new Redis();
		mockIsRedisHealthy.mockReset();
	});

	describe('shouldBackoffDomain', () => {
		it('returns false when no failure state exists', async () => {
			const result = await shouldBackoffDomain(redis, 'example.com');
			expect(result.backoff).toBe(false);
		});
	});

	describe('recordDomainFailure', () => {
		it('causes shouldBackoffDomain to return true with retryAfter', async () => {
			await recordDomainFailure(redis, 'fail.com');

			const result = await shouldBackoffDomain(redis, 'fail.com');
			expect(result.backoff).toBe(true);
			expect(result.retryAfter).toBeGreaterThan(0);
		});

		it('applies exponential backoff: first=30s, second=60s', async () => {
			await recordDomainFailure(redis, 'exp.com');
			const first = await shouldBackoffDomain(redis, 'exp.com');

			await recordDomainFailure(redis, 'exp.com');
			const second = await shouldBackoffDomain(redis, 'exp.com');

			// Second failure should have a longer retryAfter than the first
			expect(second.retryAfter!).toBeGreaterThan(first.retryAfter! * 0.9);
		});
	});

	describe('clearDomainFailure', () => {
		it('removes failure state', async () => {
			await recordDomainFailure(redis, 'clear.com');
			await clearDomainFailure(redis, 'clear.com');

			const result = await shouldBackoffDomain(redis, 'clear.com');
			expect(result.backoff).toBe(false);
		});
	});

	describe('checkSystemHealth', () => {
		it('returns redisHealthy=true when isRedisHealthy returns true', async () => {
			mockIsRedisHealthy.mockResolvedValue(true);

			const state = await checkSystemHealth(redis);
			expect(state.redisHealthy).toBe(true);
		});

		it('returns redisHealthy=false when isRedisHealthy returns false', async () => {
			mockIsRedisHealthy.mockResolvedValue(false);

			const state = await checkSystemHealth(redis);
			expect(state.redisHealthy).toBe(false);
		});
	});

	// ────────────────────────────────────────────────────────────────────
	// PR-73 regression lock: connection-level domain backoff.
	// Locks the exact exponential schedule 30000 * 2^(n-1) capped at
	// 600000ms, clear-on-success, and the PX-driven auto-clear once the
	// backoff window has elapsed. This is the TCP/connection-failure
	// back-off, distinct from the SMTP-response intelligence layer.
	// ────────────────────────────────────────────────────────────────────
	describe('PR-73: exponential connection backoff schedule', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-03-22T12:00:00Z'));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('follows 30000 * 2^(n-1) and caps at 600000ms', async () => {
			// count → expected delay (ms)
			const expected = [
				30_000, // 1: 30000 * 2^0
				60_000, // 2: 30000 * 2^1
				120_000, // 3
				240_000, // 4
				480_000, // 5
				600_000, // 6: 960000 capped at 600000
				600_000, // 7: stays capped
			];

			for (let i = 0; i < expected.length; i++) {
				await recordDomainFailure(redis, 'sched.com');
				const result = await shouldBackoffDomain(redis, 'sched.com');
				expect(result.backoff).toBe(true);
				// retryAfter is computed as retryAt - now; with frozen time it
				// equals the delay exactly.
				expect(result.retryAfter).toBe(expected[i]);
			}
		});

		it('first failure backs off exactly 30s (the base)', async () => {
			await recordDomainFailure(redis, 'base.com');
			const result = await shouldBackoffDomain(redis, 'base.com');
			expect(result.retryAfter).toBe(30_000);
		});
	});

	describe('PR-73: backoff clears on success and after the window elapses', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-03-22T12:00:00Z'));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('clearDomainFailure resets the schedule back to the 30s base', async () => {
			// Escalate to the third step (120s).
			await recordDomainFailure(redis, 'reset.com');
			await recordDomainFailure(redis, 'reset.com');
			await recordDomainFailure(redis, 'reset.com');
			expect((await shouldBackoffDomain(redis, 'reset.com')).retryAfter).toBe(120_000);

			// A successful connection clears BOTH the retry-at key and the count.
			await clearDomainFailure(redis, 'reset.com');
			expect((await shouldBackoffDomain(redis, 'reset.com')).backoff).toBe(false);

			// The next failure starts over at the 30s base (count was reset).
			await recordDomainFailure(redis, 'reset.com');
			expect((await shouldBackoffDomain(redis, 'reset.com')).retryAfter).toBe(30_000);
		});

		it('shouldBackoffDomain auto-clears the key once the backoff window has elapsed', async () => {
			await recordDomainFailure(redis, 'elapse.com'); // 30s window
			expect((await shouldBackoffDomain(redis, 'elapse.com')).backoff).toBe(true);

			// Advance just past the 30s window: the stored retryAt is now in the
			// past, so shouldBackoffDomain deletes the key and reports no backoff.
			vi.setSystemTime(new Date(Date.now() + 30_001));
			const result = await shouldBackoffDomain(redis, 'elapse.com');
			expect(result.backoff).toBe(false);

			// The retry key was actively deleted (not merely expired-by-TTL).
			const raw = await redis.get('mta:domain-fail:elapse.com');
			expect(raw).toBeNull();
		});
	});
});
