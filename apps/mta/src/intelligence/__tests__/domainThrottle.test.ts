import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { acquireSlot, recordSuccess, recordDefer, recordReject, getThrottleState } from '../domainThrottle.js';
import { setProfile } from '../../config/ispProfiles.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('domainThrottle', () => {
	let redis: RealRedis;
	const ip = '10.0.0.1';

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-22T12:00:00Z'));
	});

	afterEach(async () => {
		vi.useRealTimers();
		await redis.flushall();
	});

	describe('acquireSlot', () => {
		it('initializes rate from ISP profile default (gmail=100)', async () => {
			await acquireSlot(redis, ip, 'gmail.com');

			const state = await getThrottleState(redis, ip, 'gmail.com');
			expect(state).not.toBeNull();
			expect(state!.currentRate).toBe(100);
			expect(state!.status).toBe('healthy');
		});

		it('returns true when under rate limit', async () => {
			const result = await acquireSlot(redis, ip, 'gmail.com');
			expect(result).toBe(true);
		});

		it('returns false when blocking status within 5min', async () => {
			const hashKey = `mta:throttle:${ip}:gmail.com`;
			const now = Date.now();
			await redis.hset(
				hashKey,
				'currentRate', '100',
				'status', 'blocking',
				'lastDeferAt', String(now)
			);

			const result = await acquireSlot(redis, ip, 'gmail.com');
			expect(result).toBe(false);
		});

		it('auto-recovers from blocking after 5 minutes', async () => {
			const hashKey = `mta:throttle:${ip}:gmail.com`;
			const fiveMinAgo = Date.now() - 301_000;
			await redis.hset(
				hashKey,
				'currentRate', '100',
				'status', 'blocking',
				'lastDeferAt', String(fiveMinAgo)
			);

			const result = await acquireSlot(redis, ip, 'gmail.com');
			expect(result).toBe(true);

			const state = await getThrottleState(redis, ip, 'gmail.com');
			expect(state!.status).toBe('degraded');
		});
	});

	describe('recordSuccess', () => {
		it('increments consecutiveSuccess', async () => {
			// Initialize slot first
			await acquireSlot(redis, ip, 'gmail.com');
			await recordSuccess(redis, ip, 'gmail.com');

			const state = await getThrottleState(redis, ip, 'gmail.com');
			expect(state!.consecutiveSuccess).toBe(1);
		});

		it('increases rate after 20 consecutive successes', async () => {
			await acquireSlot(redis, ip, 'gmail.com');
			const initialState = await getThrottleState(redis, ip, 'gmail.com');
			const initialRate = initialState!.currentRate;

			for (let i = 0; i < 20; i++) {
				await recordSuccess(redis, ip, 'gmail.com');
			}

			const state = await getThrottleState(redis, ip, 'gmail.com');
			// gmail recoveryFactor is 1.1
			expect(state!.currentRate).toBe(initialRate * 1.1);
			expect(state!.consecutiveSuccess).toBe(0); // reset after recovery
		});

		it('rate does not exceed ceiling', async () => {
			const hashKey = `mta:throttle:${ip}:gmail.com`;
			// Set rate close to ceiling (gmail ceiling = 300)
			await redis.hset(hashKey, 'currentRate', '295', 'status', 'healthy', 'consecutiveSuccess', '0');

			for (let i = 0; i < 20; i++) {
				await recordSuccess(redis, ip, 'gmail.com');
			}

			const state = await getThrottleState(redis, ip, 'gmail.com');
			// 295 * 1.1 = 324.5, capped at 300
			expect(state!.currentRate).toBe(300);
		});
	});

	describe('recordDefer', () => {
		it('reduces rate by backoffFactor', async () => {
			await acquireSlot(redis, ip, 'gmail.com');
			const beforeState = await getThrottleState(redis, ip, 'gmail.com');

			await recordDefer(redis, ip, 'gmail.com');

			const afterState = await getThrottleState(redis, ip, 'gmail.com');
			// gmail backoffFactor = 0.5
			expect(afterState!.currentRate).toBe(beforeState!.currentRate * 0.5);
		});

		it('rate does not go below floor', async () => {
			const hashKey = `mta:throttle:${ip}:gmail.com`;
			// gmail floor = 5
			await redis.hset(hashKey, 'currentRate', '6', 'status', 'healthy');

			await recordDefer(redis, ip, 'gmail.com');

			const state = await getThrottleState(redis, ip, 'gmail.com');
			// 6 * 0.5 = 3, but floor is 5
			expect(state!.currentRate).toBe(5);
		});

		it('marks as degraded', async () => {
			await acquireSlot(redis, ip, 'gmail.com');
			await recordDefer(redis, ip, 'gmail.com');

			const state = await getThrottleState(redis, ip, 'gmail.com');
			expect(state!.status).toBe('degraded');
		});

		it('3+ defers within 5min marks as blocking', async () => {
			await acquireSlot(redis, ip, 'gmail.com');

			// Three defers within 5 minutes
			await recordDefer(redis, ip, 'gmail.com');
			vi.advanceTimersByTime(60_000); // 1 min later
			await recordDefer(redis, ip, 'gmail.com');
			vi.advanceTimersByTime(60_000); // 1 min later
			await recordDefer(redis, ip, 'gmail.com');

			const state = await getThrottleState(redis, ip, 'gmail.com');
			expect(state!.status).toBe('blocking');
		});
	});

	describe('recordReject', () => {
		it('resets consecutiveSuccess to 0', async () => {
			await acquireSlot(redis, ip, 'gmail.com');
			// Build up some consecutive successes
			await recordSuccess(redis, ip, 'gmail.com');
			await recordSuccess(redis, ip, 'gmail.com');

			const before = await getThrottleState(redis, ip, 'gmail.com');
			expect(before!.consecutiveSuccess).toBe(2);

			await recordReject(redis, ip, 'gmail.com');

			const after = await getThrottleState(redis, ip, 'gmail.com');
			expect(after!.consecutiveSuccess).toBe(0);
		});
	});

	describe('acquireSlot atomicity', () => {
		it('concurrent acquireSlot calls do not exceed rate limit', async () => {
			// Set a low rate to make it easy to test
			const hashKey = `mta:throttle:${ip}:gmail.com`;
			await redis.hset(hashKey, 'currentRate', '3', 'status', 'healthy');

			// Fire 5 concurrent acquireSlot calls — only 3 should succeed
			const results = await Promise.all([
				acquireSlot(redis, ip, 'gmail.com'),
				acquireSlot(redis, ip, 'gmail.com'),
				acquireSlot(redis, ip, 'gmail.com'),
				acquireSlot(redis, ip, 'gmail.com'),
				acquireSlot(redis, ip, 'gmail.com'),
			]);

			const granted = results.filter((r) => r === true).length;
			const denied = results.filter((r) => r === false).length;
			expect(granted).toBeLessThanOrEqual(3);
			expect(denied).toBeGreaterThanOrEqual(2);
		});

		it('uses default profile rate for unknown domains', async () => {
			// __default__ profile has defaultRate: 30
			await acquireSlot(redis, ip, 'somerandomisp.org');

			const state = await getThrottleState(redis, ip, 'somerandomisp.org');
			expect(state).not.toBeNull();
			expect(state!.currentRate).toBe(30);
		});

		it('acquireSlot still initializes correctly via Lua script', async () => {
			const result = await acquireSlot(redis, ip, 'yahoo.com');
			expect(result).toBe(true);

			const state = await getThrottleState(redis, ip, 'yahoo.com');
			expect(state).not.toBeNull();
			// yahoo profile: defaultRate=50
			expect(state!.currentRate).toBe(50);
			expect(state!.status).toBe('healthy');
		});
	});

	describe('runtime Redis-backed ISP profiles', () => {
		it('honors a runtime profile override on the throttle hot path (defaultRate=1)', async () => {
			// Operator lowers gmail.com's rate during a deliverability incident.
			// Before the fix domainThrottle read the static compiled profile
			// (defaultRate=100) and this override had ZERO effect — ~100 slots
			// per window would be granted.
			await setProfile(redis, 'gmail.com', { defaultRate: 1, ceiling: 1, floor: 1 });

			// First acquisition within the 60s window succeeds and seeds the
			// adaptive rate from the runtime defaultRate.
			const first = await acquireSlot(redis, ip, 'gmail.com');
			expect(first).toBe(true);

			const state = await getThrottleState(redis, ip, 'gmail.com');
			expect(state!.currentRate).toBe(1);

			// Every subsequent acquisition within the same window must be denied
			// (rate of 1/min). Loop to prove it is not just an off-by-one.
			for (let i = 0; i < 10; i++) {
				const result = await acquireSlot(redis, ip, 'gmail.com');
				expect(result).toBe(false);
			}
		});

		it('initializes the adaptive rate from a runtime override for a known domain', async () => {
			// yahoo.com static defaultRate is 50; override it to 7 at runtime.
			await setProfile(redis, 'yahoo.com', { defaultRate: 7, ceiling: 20, floor: 1 });

			await acquireSlot(redis, ip, 'yahoo.com');

			const state = await getThrottleState(redis, ip, 'yahoo.com');
			expect(state!.currentRate).toBe(7);
		});

		it('uses the runtime ceiling when recovering rate', async () => {
			// Lower gmail's ceiling to 12 at runtime; recovery must respect it.
			await setProfile(redis, 'gmail.com', { defaultRate: 5, ceiling: 12, floor: 1 });

			const hashKey = `mta:throttle:${ip}:gmail.com`;
			// Sit just below the runtime ceiling so one recovery step would
			// overshoot the static ceiling (300) but must be capped at 12.
			await redis.hset(hashKey, 'currentRate', '11', 'status', 'healthy', 'consecutiveSuccess', '0');

			for (let i = 0; i < 20; i++) {
				await recordSuccess(redis, ip, 'gmail.com');
			}

			const state = await getThrottleState(redis, ip, 'gmail.com');
			// 11 * 1.1 = 12.1, capped at the runtime ceiling of 12.
			expect(state!.currentRate).toBe(12);
		});

		it('uses the runtime floor when backing off rate', async () => {
			// Raise gmail's floor to 10 at runtime; backoff must respect it.
			await setProfile(redis, 'gmail.com', { defaultRate: 20, ceiling: 50, floor: 10 });

			const hashKey = `mta:throttle:${ip}:gmail.com`;
			await redis.hset(hashKey, 'currentRate', '14', 'status', 'healthy');

			await recordDefer(redis, ip, 'gmail.com');

			const state = await getThrottleState(redis, ip, 'gmail.com');
			// 14 * 0.5 = 7, but the runtime floor is 10.
			expect(state!.currentRate).toBe(10);
		});
	});

	// ──────────────────────────────────────────────────────────────────────
	// PR-73 regression lock: deliverability-engine throttling invariants.
	// Locks the EXACT acquireSlot cap, race-free concurrency, the defer→floor→
	// blocking backoff path, the 1h auto-recover, and the success ramp to the
	// ISP ceiling. These mirror how ISPs (Gmail/Yahoo, 2024 sender rules)
	// evaluate per-source-IP cadence; RFC 5321 §4.5.3.1/§4.5.4 govern the 4xx
	// defer-and-retry contract these controls implement.
	// ──────────────────────────────────────────────────────────────────────
	describe('PR-73: acquireSlot exact cap', () => {
		it('grants exactly defaultRate slots per window then denies (gmail=100)', async () => {
			// Seed the adaptive rate explicitly so the cap is unambiguous.
			const hashKey = `mta:throttle:${ip}:gmail.com`;
			await redis.hset(hashKey, 'currentRate', '100', 'status', 'healthy');

			let granted = 0;
			// Try 120 sequential acquisitions inside the same 60s window.
			for (let i = 0; i < 120; i++) {
				if (await acquireSlot(redis, ip, 'gmail.com')) granted++;
			}

			// Exactly the cap is admitted; the rest are denied.
			expect(granted).toBe(100);
		});

		it('grants exactly the runtime-overridden cap (rate=7)', async () => {
			await setProfile(redis, 'yahoo.com', { defaultRate: 7, ceiling: 20, floor: 1 });

			let granted = 0;
			for (let i = 0; i < 30; i++) {
				if (await acquireSlot(redis, ip, 'yahoo.com')) granted++;
			}

			expect(granted).toBe(7);
		});
	});

	describe('PR-73: acquireSlot is race-free under parallel load', () => {
		it('50 parallel acquireSlot calls grant EXACTLY currentRate (no overshoot)', async () => {
			const hashKey = `mta:throttle:${ip}:gmail.com`;
			const currentRate = 12;
			await redis.hset(hashKey, 'currentRate', String(currentRate), 'status', 'healthy');

			// Fire 50 concurrent acquisitions for the same IP+domain. The Lua
			// check-and-increment must admit EXACTLY currentRate — never more
			// (that would breach the cap) and never fewer (that would waste
			// capacity). This is the property the atomic script exists for.
			const results = await Promise.all(
				Array.from({ length: 50 }, () => acquireSlot(redis, ip, 'gmail.com')),
			);

			const granted = results.filter((r) => r === true).length;
			const denied = results.filter((r) => r === false).length;
			expect(granted).toBe(currentRate);
			expect(denied).toBe(50 - currentRate);
		});

		it('the window count never exceeds the rate after a concurrent burst', async () => {
			const hashKey = `mta:throttle:${ip}:outlook.com`;
			await redis.hset(hashKey, 'currentRate', '5', 'status', 'healthy');

			await Promise.all(
				Array.from({ length: 40 }, () => acquireSlot(redis, ip, 'outlook.com')),
			);

			// The sorted-set window holds at most `currentRate` admitted entries.
			const windowKey = `mta:throttle:window:${ip}:outlook.com`;
			const windowCount = await redis.zcard(windowKey);
			expect(windowCount).toBe(5);
		});
	});

	describe('PR-73: recordDefer backoff path → floor → blocking', () => {
		it('three defers within 5 minutes ratchet down toward floor and mark blocking', async () => {
			const hashKey = `mta:throttle:${ip}:gmail.com`;
			await redis.hset(hashKey, 'currentRate', '100', 'status', 'healthy');

			// Defer #1: degraded, 100 * 0.5 = 50
			await recordDefer(redis, ip, 'gmail.com');
			let state = await getThrottleState(redis, ip, 'gmail.com');
			expect(state!.status).toBe('degraded');
			expect(state!.currentRate).toBe(50);

			// Defer #2 (within window): still degraded, 50 * 0.5 = 25
			vi.advanceTimersByTime(60_000);
			await recordDefer(redis, ip, 'gmail.com');
			state = await getThrottleState(redis, ip, 'gmail.com');
			expect(state!.status).toBe('degraded');
			expect(state!.currentRate).toBe(25);

			// Defer #3 (within window): 3rd rapid defer → blocking, 25 * 0.5 = 12.5
			vi.advanceTimersByTime(60_000);
			await recordDefer(redis, ip, 'gmail.com');
			state = await getThrottleState(redis, ip, 'gmail.com');
			expect(state!.status).toBe('blocking');
			expect(state!.currentRate).toBe(12.5);
		});

		it('a defer after >5min resets the rapid-defer counter (no premature blocking)', async () => {
			const hashKey = `mta:throttle:${ip}:gmail.com`;
			await redis.hset(hashKey, 'currentRate', '100', 'status', 'healthy');

			await recordDefer(redis, ip, 'gmail.com'); // recentDefers = 1
			vi.advanceTimersByTime(60_000);
			await recordDefer(redis, ip, 'gmail.com'); // recentDefers = 2

			// Gap longer than the 5-minute window resets the counter to 1.
			vi.advanceTimersByTime(301_000);
			await recordDefer(redis, ip, 'gmail.com');

			const state = await getThrottleState(redis, ip, 'gmail.com');
			expect(state!.status).toBe('degraded'); // NOT blocking — counter reset
		});

		it('repeated defers clamp the rate at the floor and never below', async () => {
			const hashKey = `mta:throttle:${ip}:gmail.com`;
			await redis.hset(hashKey, 'currentRate', '100', 'status', 'healthy');

			// Hammer many defers; gmail floor = 5.
			for (let i = 0; i < 12; i++) {
				await recordDefer(redis, ip, 'gmail.com');
				vi.advanceTimersByTime(10_000);
			}

			const state = await getThrottleState(redis, ip, 'gmail.com');
			expect(state!.currentRate).toBe(5);
		});
	});

	describe('PR-73: blocking auto-recovery', () => {
		it('stays blocked within 5 minutes of the last defer', async () => {
			const hashKey = `mta:throttle:${ip}:gmail.com`;
			await redis.hset(
				hashKey,
				'currentRate', '50',
				'status', 'blocking',
				'lastDeferAt', String(Date.now() - 60_000), // 1 min ago
			);

			expect(await acquireSlot(redis, ip, 'gmail.com')).toBe(false);
			const state = await getThrottleState(redis, ip, 'gmail.com');
			expect(state!.status).toBe('blocking');
		});

		it('auto-recovers to healthy after 1 hour of inactivity', async () => {
			const hashKey = `mta:throttle:${ip}:gmail.com`;
			await redis.hset(
				hashKey,
				'currentRate', '50',
				'status', 'blocking',
				'lastDeferAt', String(Date.now() - 3_600_001), // just over 1h ago
				'recentDefers', '3',
				'consecutiveSuccess', '0',
			);

			// First acquire after 1h flips blocking → healthy and is admitted.
			expect(await acquireSlot(redis, ip, 'gmail.com')).toBe(true);

			const state = await getThrottleState(redis, ip, 'gmail.com');
			expect(state!.status).toBe('healthy');
			// recentDefers is cleared on the 1h recovery so a single future
			// defer cannot immediately re-trip blocking.
			const recentDefers = await redis.hget(hashKey, 'recentDefers');
			expect(recentDefers).toBe('0');
		});
	});

	describe('PR-73: recordSuccess ramps the rate to the ISP ceiling', () => {
		it('multiple recovery cycles climb toward and then clamp at the gmail ceiling (300)', async () => {
			const hashKey = `mta:throttle:${ip}:gmail.com`;
			await redis.hset(hashKey, 'currentRate', '100', 'status', 'healthy', 'consecutiveSuccess', '0');

			// 30 cycles of 20 consecutive successes each (recoveryFactor 1.1).
			// 100 * 1.1^n grows past the 300 ceiling and must clamp there.
			for (let cycle = 0; cycle < 30; cycle++) {
				for (let i = 0; i < 20; i++) {
					await recordSuccess(redis, ip, 'gmail.com');
				}
			}

			const state = await getThrottleState(redis, ip, 'gmail.com');
			expect(state!.currentRate).toBe(300); // gmail ceiling, never exceeded
			expect(state!.status).toBe('healthy');
		});

		it('a recovery step from blocking restores healthy status', async () => {
			const hashKey = `mta:throttle:${ip}:gmail.com`;
			await redis.hset(hashKey, 'currentRate', '20', 'status', 'blocking', 'consecutiveSuccess', '0');

			for (let i = 0; i < 20; i++) {
				await recordSuccess(redis, ip, 'gmail.com');
			}

			const state = await getThrottleState(redis, ip, 'gmail.com');
			expect(state!.status).toBe('healthy');
			expect(state!.currentRate).toBe(22); // 20 * 1.1
		});
	});

	describe('getThrottleState', () => {
		it('returns null for unknown pair', async () => {
			const state = await getThrottleState(redis, ip, 'unknown.com');
			expect(state).toBeNull();
		});

		it('returns correct shape after operations', async () => {
			await acquireSlot(redis, ip, 'gmail.com');
			await recordSuccess(redis, ip, 'gmail.com');

			const state = await getThrottleState(redis, ip, 'gmail.com');
			expect(state).toEqual({
				currentRate: 100,
				status: 'healthy',
				consecutiveSuccess: 1,
			});
		});
	});
});
