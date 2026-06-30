import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import {
	getDailyCap,
	checkCap,
	recordSend,
	recordBounce,
	recordDeferral,
	initializeWarming,
	evaluateDay,
	getWarmingState,
} from '../warming.js';
import { createTestConfig } from '../../__tests__/helpers/fixtures.js';
import { getWarmingCapForDay } from '@owlat/shared/warming';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: vi.fn().mockResolvedValue(true),
}));

describe('warming', () => {
	let redis: RealRedis;
	const ip = '10.0.0.1';
	const config = createTestConfig();

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-22T12:00:00Z'));
	});

	afterEach(async () => {
		vi.useRealTimers();
		await redis.flushall();
	});

	describe('initializeWarming', () => {
		it('sets day 1, cap 50, phase ramp', async () => {
			await initializeWarming(redis, ip);

			const state = await getWarmingState(redis, ip);
			expect(state).not.toBeNull();
			expect(state!.currentDay).toBe(1);
			expect(state!.dailyCap).toBe(50);
			expect(state!.phase).toBe('ramp');
			expect(state!.sentToday).toBe(0);
		});

		it('is idempotent (calling twice does not overwrite)', async () => {
			await initializeWarming(redis, ip);
			const firstState = await getWarmingState(redis, ip);

			// Modify state to verify it won't be overwritten
			await redis.hset(`mta:warming:${ip}`, 'currentDay', '5');

			await initializeWarming(redis, ip);
			const secondState = await getWarmingState(redis, ip);
			expect(secondState!.currentDay).toBe(5);
			expect(secondState!.startedAt).toBe(firstState!.startedAt);
		});
	});

	describe('checkCap', () => {
		it('returns allowed:true and dailyCap:Infinity when no state', async () => {
			const result = await checkCap(redis, ip);
			expect(result.allowed).toBe(true);
			expect(result.dailyCap).toBe(Infinity);
		});

		it('returns allowed:true when sentToday < dailyCap', async () => {
			await initializeWarming(redis, ip);
			// sentToday = 0, dailyCap = 50
			const result = await checkCap(redis, ip);
			expect(result.allowed).toBe(true);
			expect(result.sentToday).toBe(0);
			expect(result.dailyCap).toBe(50);
		});

		it('returns allowed:false when sentToday >= dailyCap', async () => {
			await initializeWarming(redis, ip);
			// Set sentToday to cap
			await redis.hset(`mta:warming:${ip}`, 'sentToday', '50');

			const result = await checkCap(redis, ip);
			expect(result.allowed).toBe(false);
			expect(result.sentToday).toBe(50);
			expect(result.dailyCap).toBe(50);
		});
	});

	describe('getDailyCap', () => {
		it('returns Infinity for graduated IP', async () => {
			await initializeWarming(redis, ip);
			await redis.hset(`mta:warming:${ip}`, 'phase', 'graduated', 'dailyCap', String(Infinity));

			const cap = await getDailyCap(redis, ip);
			expect(cap).toBe(Infinity);
		});
	});

	describe('recordSend', () => {
		it('increments sentToday and daily stats', async () => {
			await initializeWarming(redis, ip);

			await recordSend(redis, ip);
			await recordSend(redis, ip);

			const state = await getWarmingState(redis, ip);
			expect(state!.sentToday).toBe(2);

			const dailySent = await redis.hget('mta:warming:daily:10.0.0.1:2026-03-22', 'sent');
			expect(dailySent).toBe('2');
		});
	});

	describe('evaluateDay', () => {
		it('skips when no sends', async () => {
			await initializeWarming(redis, ip);

			await evaluateDay(redis, ip, config);

			const state = await getWarmingState(redis, ip);
			// Should remain unchanged
			expect(state!.currentDay).toBe(1);
			expect(state!.dailyCap).toBe(50);
		});

		it('skips when graduated', async () => {
			await initializeWarming(redis, ip);
			await redis.hset(`mta:warming:${ip}`, 'phase', 'graduated', 'dailyCap', String(Infinity));

			// Record some sends in daily stats
			await redis.hset('mta:warming:daily:10.0.0.1:2026-03-22', 'sent', '100', 'bounced', '50');

			await evaluateDay(redis, ip, config);

			const state = await getWarmingState(redis, ip);
			expect(state!.phase).toBe('graduated');
		});

		it('HALT: bounce>8% sets phase to plateau', async () => {
			await initializeWarming(redis, ip);
			await redis.hset(`mta:warming:${ip}`, 'dailyCap', '100');

			// 10 sent, 1 bounced = 10% > 8%
			await redis.hset('mta:warming:daily:10.0.0.1:2026-03-22', 'sent', '10', 'bounced', '1');

			await evaluateDay(redis, ip, config);

			const state = await getWarmingState(redis, ip);
			expect(state!.phase).toBe('plateau');
		});

		it('DECELERATE: bounce 4% reduces cap by 0.7x', async () => {
			await initializeWarming(redis, ip);
			await redis.hset(`mta:warming:${ip}`, 'dailyCap', '200', 'currentDay', '5');

			// 100 sent, 4 bounced = 4% > 3%
			await redis.hset('mta:warming:daily:10.0.0.1:2026-03-22', 'sent', '100', 'bounced', '4');

			await evaluateDay(redis, ip, config);

			const state = await getWarmingState(redis, ip);
			expect(state!.dailyCap).toBe(Math.max(50, Math.floor(200 * 0.7)));
			expect(state!.phase).toBe('ramp');
		});

		it('ACCELERATE: bounce<1%, defer<5%, usage>80% increases day by 1.5x', async () => {
			await initializeWarming(redis, ip);
			await redis.hset(`mta:warming:${ip}`, 'dailyCap', '200', 'currentDay', '5');

			// 180 sent out of 200 cap = 90% usage, 0 bounces, 0 defers
			await redis.hset('mta:warming:daily:10.0.0.1:2026-03-22', 'sent', '180', 'bounced', '0', 'deferred', '0');

			await evaluateDay(redis, ip, config);

			const state = await getWarmingState(redis, ip);
			// day 5 * 1.5 = 7.5 → floor(7.5) = 7
			expect(state!.currentDay).toBe(7);
		});

		it('NORMAL: advances day by 1', async () => {
			await initializeWarming(redis, ip);
			await redis.hset(`mta:warming:${ip}`, 'dailyCap', '200', 'currentDay', '5');

			// 100 sent, 2 bounced = 2% (between 1% and 3%), 0 deferred
			// This doesn't hit accelerate (bounce >=1%) or decelerate (bounce <=3%)
			await redis.hset('mta:warming:daily:10.0.0.1:2026-03-22', 'sent', '100', 'bounced', '2', 'deferred', '0');

			await evaluateDay(redis, ip, config);

			const state = await getWarmingState(redis, ip);
			expect(state!.currentDay).toBe(6);
		});

		it('GRADUATION: day>=30, bounce<2% sets phase graduated and cap Infinity', async () => {
			await initializeWarming(redis, ip);
			await redis.hset(`mta:warming:${ip}`, 'dailyCap', '30000', 'currentDay', '30');

			// 1000 sent, 5 bounced = 0.5% < 2%
			await redis.hset('mta:warming:daily:10.0.0.1:2026-03-22', 'sent', '1000', 'bounced', '5', 'deferred', '0');

			await evaluateDay(redis, ip, config);

			const state = await getWarmingState(redis, ip);
			expect(state!.phase).toBe('graduated');
			expect(state!.dailyCap).toBe(Infinity);
		});
	});

	describe('evaluateDay per-UTC-day idempotency', () => {
		it('advances currentDay by AT MOST 1 across 24 hourly calls in the same UTC date', async () => {
			// This is the regression for the audited bug: before the guard, a
			// clean IP graduated the whole 30-day schedule in ~30 hourly cron
			// ticks. Use a NORMAL-branch scenario (bounce between accelerate and
			// decelerate thresholds) so a single step is a clean +1.
			await initializeWarming(redis, ip);
			await redis.hset(`mta:warming:${ip}`, 'currentDay', '1', 'dailyCap', '50');

			// 40 sent, 1 bounced = 2.5% (>1% so NOT accelerate, <3% so NOT
			// decelerate) → NORMAL branch advances exactly one schedule day.
			await redis.hset('mta:warming:daily:10.0.0.1:2026-03-22', 'sent', '40', 'bounced', '1', 'deferred', '0');

			const dayTwoCap = getWarmingCapForDay(2);

			// Hourly cron: 24 invocations within the SAME simulated UTC date.
			for (let h = 0; h < 24; h++) {
				await evaluateDay(redis, ip, config);
			}

			const after = await getWarmingState(redis, ip);
			// Started at day 1; 24 evaluations advance the schedule by exactly one
			// UTC day — NOT 24. (Pre-fix this raced to graduation.)
			expect(after!.currentDay).toBe(2);
			expect(after!.dailyCap).toBe(dayTwoCap);
			expect(after!.lastEvaluatedDate).toBe('2026-03-22');
		});

		it('24 calls produce the same state as a single call (pure idempotency, even on the accelerate branch)', async () => {
			await initializeWarming(redis, ip);
			await redis.hset(`mta:warming:${ip}`, 'currentDay', '5', 'dailyCap', '200');
			// 180/200 = 90% usage, clean → accelerate branch.
			await redis.hset('mta:warming:daily:10.0.0.1:2026-03-22', 'sent', '180', 'bounced', '0', 'deferred', '0');

			for (let h = 0; h < 24; h++) {
				await evaluateDay(redis, ip, config);
			}
			const after24 = await getWarmingState(redis, ip);

			// Reset to the same starting point and call exactly once.
			await redis.flushall();
			await initializeWarming(redis, ip);
			await redis.hset(`mta:warming:${ip}`, 'currentDay', '5', 'dailyCap', '200');
			await redis.hset('mta:warming:daily:10.0.0.1:2026-03-22', 'sent', '180', 'bounced', '0', 'deferred', '0');
			await evaluateDay(redis, ip, config);
			const after1 = await getWarmingState(redis, ip);

			expect(after24!.currentDay).toBe(after1!.currentDay);
			expect(after24!.dailyCap).toBe(after1!.dailyCap);
		});

		it('advances again once the UTC date rolls over', async () => {
			await initializeWarming(redis, ip);
			await redis.hset(`mta:warming:${ip}`, 'currentDay', '1', 'dailyCap', '50');
			await redis.hset('mta:warming:daily:10.0.0.1:2026-03-22', 'sent', '40', 'bounced', '1', 'deferred', '0');

			// First day: evaluate (hourly, but idempotent) → day advances once.
			for (let h = 0; h < 24; h++) {
				await evaluateDay(redis, ip, config);
			}
			const afterDay1 = await getWarmingState(redis, ip);
			const day1Value = afterDay1!.currentDay;
			expect(day1Value).toBe(2); // NORMAL +1 from day 1

			// Roll the clock forward one UTC day and record clean sends for it.
			vi.setSystemTime(new Date('2026-03-23T12:00:00Z'));
			await redis.hset('mta:warming:daily:10.0.0.1:2026-03-23', 'sent', '40', 'bounced', '1', 'deferred', '0');

			await evaluateDay(redis, ip, config);
			const afterDay2 = await getWarmingState(redis, ip);
			expect(afterDay2!.currentDay).toBe(day1Value + 1);
			expect(afterDay2!.lastEvaluatedDate).toBe('2026-03-23');
		});

		it('does not arm the guard on a no-send day, so a later call the same day still evaluates', async () => {
			await initializeWarming(redis, ip);
			await redis.hset(`mta:warming:${ip}`, 'currentDay', '5', 'dailyCap', '200');

			// First call: no sends recorded yet → no-op, guard stays unset.
			await evaluateDay(redis, ip, config);
			const mid = await getWarmingState(redis, ip);
			expect(mid!.currentDay).toBe(5);
			expect(mid!.lastEvaluatedDate).toBe('');

			// Sends arrive later the same UTC day; the next call must evaluate.
			await redis.hset('mta:warming:daily:10.0.0.1:2026-03-22', 'sent', '100', 'bounced', '2', 'deferred', '0');
			await evaluateDay(redis, ip, config);
			const after = await getWarmingState(redis, ip);
			expect(after!.currentDay).toBe(6);
			expect(after!.lastEvaluatedDate).toBe('2026-03-22');
		});
	});

	describe('checkCap atomic day-rollover reset', () => {
		it('resets sentToday exactly once when two checkCap calls race at a rolled-over date', async () => {
			await initializeWarming(redis, ip);
			// Simulate yesterday's leftover counter.
			await redis.hset(`mta:warming:${ip}`, 'sentToday', '37', 'sentTodayReset', '2026-03-21');

			// Two concurrent checkCap calls at today's date. Both observe the stale
			// reset date, but the Lua script must reset sentToday exactly once — the
			// stored counter must be 0 (not negative / not re-incremented), and both
			// callers must see sentToday 0.
			const [a, b] = await Promise.all([checkCap(redis, ip), checkCap(redis, ip)]);

			expect(a.sentToday).toBe(0);
			expect(b.sentToday).toBe(0);

			const state = await getWarmingState(redis, ip);
			expect(state!.sentToday).toBe(0);
			expect(state!.sentTodayReset).toBe('2026-03-22');
		});

		it('preserves sentToday when the date has not rolled over', async () => {
			await initializeWarming(redis, ip);
			await redis.hset(`mta:warming:${ip}`, 'sentToday', '12', 'sentTodayReset', '2026-03-22', 'dailyCap', '50');

			const result = await checkCap(redis, ip);
			expect(result.sentToday).toBe(12);
			expect(result.dailyCap).toBe(50);
			expect(result.allowed).toBe(true);

			const state = await getWarmingState(redis, ip);
			expect(state!.sentToday).toBe(12);
		});
	});
});
