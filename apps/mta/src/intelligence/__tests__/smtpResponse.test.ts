import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';
import { shouldDefer, recordResponse, getDomainHealth } from '../smtpResponse.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('smtpResponse', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
	});

	describe('shouldDefer', () => {
		it('returns 0 when no retry key exists', async () => {
			const result = await shouldDefer(redis, 'example.com');
			expect(result).toBe(0);
		});

		it('returns remaining ms when retry key is active', async () => {
			const retryUntil = Date.now() + 60_000;
			await redis.set('mta:smtp-intel:retry:example.com', String(retryUntil), 'PX', 60_000);

			const result = await shouldDefer(redis, 'example.com');
			expect(result).toBeGreaterThan(0);
			expect(result).toBeLessThanOrEqual(60_000);
		});
	});

	describe('recordResponse', () => {
		it('stores 2xx counters', async () => {
			await recordResponse(redis, 'example.com', 250);

			const total2xx = await redis.hget('mta:smtp-intel:example.com', 'total2xx');
			const totalSent = await redis.hget('mta:smtp-intel:example.com', 'totalSent');
			expect(total2xx).toBe('1');
			expect(totalSent).toBe('1');
		});

		it('stores 4xx counters', async () => {
			await recordResponse(redis, 'example.com', 421);

			const total4xx = await redis.hget('mta:smtp-intel:example.com', 'total4xx');
			expect(total4xx).toBe('1');
		});

		it('stores 5xx counters', async () => {
			await recordResponse(redis, 'example.com', 550);

			const total5xx = await redis.hget('mta:smtp-intel:example.com', 'total5xx');
			expect(total5xx).toBe('1');
		});

		it('skips analysis with fewer than 5 responses', async () => {
			for (let i = 0; i < 4; i++) {
				await recordResponse(redis, 'example.com', 550);
			}

			const health = await redis.hget('mta:smtp-intel:example.com', 'healthStatus');
			// With fewer than 5 responses, healthStatus should not be set
			// (or should remain at default since analysis is skipped)
			expect(health === null || health === undefined || health === 'healthy').toBe(true);
		});

		it('marks blocking when >70% 5xx with 10+ responses', async () => {
			// Record 11 5xx responses (>70% and >=10)
			for (let i = 0; i < 11; i++) {
				await recordResponse(redis, 'block.com', 550);
			}

			const health = await redis.hget('mta:smtp-intel:block.com', 'healthStatus');
			expect(health).toBe('blocking');

			const deferMs = await shouldDefer(redis, 'block.com');
			expect(deferMs).toBeGreaterThan(0);
		});

		it('marks degraded when >50% 4xx and last 5 all 4xx', async () => {
			// Need at least 5 responses, >50% 4xx, last 5 all 4xx
			// Record 2 success then 5 4xx → 5/7 = 71% 4xx, last 5 all 4xx
			await recordResponse(redis, 'slow.com', 250);
			await recordResponse(redis, 'slow.com', 250);
			for (let i = 0; i < 5; i++) {
				await recordResponse(redis, 'slow.com', 421);
			}

			const health = await redis.hget('mta:smtp-intel:slow.com', 'healthStatus');
			expect(health).toBe('degraded');

			const deferMs = await shouldDefer(redis, 'slow.com');
			expect(deferMs).toBeGreaterThan(0);
		});
	});

	// ────────────────────────────────────────────────────────────────────
	// PR-73 regression lock: SMTP-response pattern deferral.
	// Locks the blocking pattern (>70% 5xx AND >=10 responses → 5-min defer)
	// and the degraded pattern (>50% 4xx AND the last 5 all 4xx → 2-min
	// defer). The 5xx/4xx split mirrors RFC 5321 §4.5.3.1 (permanent vs
	// transient negative completion) — a wall of 5xx means stop, a run of
	// 4xx means back off and retry later.
	// ────────────────────────────────────────────────────────────────────
	describe('PR-73: blocking pattern (>0.7 5xx ratio, >=10 responses)', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-03-22T12:00:00.000Z'));
		});
		afterEach(() => vi.useRealTimers());

		it('does NOT block on a high 5xx ratio with fewer than 10 5xx responses', async () => {
			// 9 × 5xx interleaved with enough 2xx to stay under the min-responses
			// gate for 5xx (BLOCKING_MIN_RESPONSES = 10). Even at a high ratio,
			// 9 < 10 must not trip blocking.
			for (let i = 0; i < 9; i++) {
				await recordResponse(redis, 'few5xx.com', 550);
			}
			const health = await redis.hget('mta:smtp-intel:few5xx.com', 'healthStatus');
			expect(health).not.toBe('blocking');
			expect(await shouldDefer(redis, 'few5xx.com')).toBe(0);
		});

		it('does NOT block at exactly 70% 5xx (threshold is strictly greater)', async () => {
			// 7 × 5xx + 3 × 2xx over 10 = exactly 0.70 ratio with 10 responses.
			// The check is `> 0.7`, so exactly 0.7 must NOT block. (count5xx=7 is
			// also below the 10-response 5xx gate, doubly safe.)
			for (let i = 0; i < 7; i++) await recordResponse(redis, 'exactly70.com', 550);
			for (let i = 0; i < 3; i++) await recordResponse(redis, 'exactly70.com', 250);

			const health = await redis.hget('mta:smtp-intel:exactly70.com', 'healthStatus');
			expect(health).not.toBe('blocking');
		});

		it('blocks at >70% 5xx with >=10 5xx and defers ~5 minutes', async () => {
			// 12 × 5xx + 2 × 2xx → 12/14 = 85.7% 5xx, and count5xx (12) >= 10.
			for (let i = 0; i < 2; i++) await recordResponse(redis, 'block5xx.com', 250);
			for (let i = 0; i < 12; i++) await recordResponse(redis, 'block5xx.com', 550);

			const health = await redis.hget('mta:smtp-intel:block5xx.com', 'healthStatus');
			expect(health).toBe('blocking');

			// Blocking defer window is 5 minutes; with frozen time the remaining
			// deferral equals the full window.
			expect(await shouldDefer(redis, 'block5xx.com')).toBe(300_000);
		});
	});

	describe('PR-73: degraded pattern (>0.5 4xx ratio AND last 5 all 4xx)', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-03-22T12:00:00.000Z'));
		});
		afterEach(() => vi.useRealTimers());

		it('degrades at >50% 4xx with the last 5 all 4xx and defers ~2 minutes', async () => {
			// 2 × 2xx then 5 × 4xx → 5/7 = 71% 4xx, and the most-recent 5 are 4xx.
			await recordResponse(redis, 'deg.com', 250);
			await recordResponse(redis, 'deg.com', 250);
			for (let i = 0; i < 5; i++) await recordResponse(redis, 'deg.com', 421);

			const health = await redis.hget('mta:smtp-intel:deg.com', 'healthStatus');
			expect(health).toBe('degraded');

			// Degraded defer window is 2 minutes.
			expect(await shouldDefer(redis, 'deg.com')).toBe(120_000);
		});

		it('does NOT degrade when the 4xx ratio is high but the last 5 are not all 4xx', async () => {
			// A high 4xx ratio (>50%) where the MOST RECENT 5 responses are NOT
			// all 4xx must NOT classify as degraded. We interleave a 2xx into the
			// last-5 window: 1 × 2xx, 4 × 4xx, then 1 × 2xx as the most recent.
			// ratio4xx = 4/6 = 67% (> 50%) but the last 5 contain a 2xx, so the
			// last-5-all-4xx guard keeps the domain healthy — and because the
			// degraded branch is never taken, no deferral is ever written.
			await recordResponse(redis, 'recover.com', 250);
			for (let i = 0; i < 4; i++) await recordResponse(redis, 'recover.com', 421);
			await recordResponse(redis, 'recover.com', 250); // most recent → breaks the last-5-all-4xx run

			const health = await redis.hget('mta:smtp-intel:recover.com', 'healthStatus');
			expect(health).not.toBe('degraded');
			// No degraded transition ever occurred, so no defer window was set.
			expect(await shouldDefer(redis, 'recover.com')).toBe(0);
		});

		it('does NOT degrade at exactly 50% 4xx (threshold is strictly greater)', async () => {
			// 3 × 2xx then 3 × 4xx → 3/6 = exactly 0.50. The check is `> 0.5`, so
			// exactly half does not degrade even though the last 3 are 4xx (the
			// last-5 window would include the 2xx anyway).
			for (let i = 0; i < 3; i++) await recordResponse(redis, 'half4xx.com', 250);
			for (let i = 0; i < 3; i++) await recordResponse(redis, 'half4xx.com', 421);

			const health = await redis.hget('mta:smtp-intel:half4xx.com', 'healthStatus');
			expect(health).not.toBe('degraded');
		});
	});

	describe('getDomainHealth', () => {
		it('returns null for unknown domain', async () => {
			const result = await getDomainHealth(redis, 'unknown.com');
			expect(result).toBeNull();
		});

		it('returns correct counters', async () => {
			await recordResponse(redis, 'test.com', 250);
			await recordResponse(redis, 'test.com', 250);
			await recordResponse(redis, 'test.com', 421);

			const result = await getDomainHealth(redis, 'test.com');
			expect(result).not.toBeNull();
			expect(result!.total2xx).toBe(2);
			expect(result!.total4xx).toBe(1);
			expect(result!.totalSent).toBe(3);
		});
	});
});
