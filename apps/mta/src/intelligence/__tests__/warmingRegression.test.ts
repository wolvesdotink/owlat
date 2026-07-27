import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { evaluateDay, getWarmingState, initializeWarming } from '../warming.js';
import {
	warmingDailyStatsKey,
	warmingProviderDailyStatsKey,
	warmingProviderStateKey,
	warmingStateKey,
} from '../warmingKeys.js';
import { createTestConfig } from '../../__tests__/helpers/fixtures.js';
import { getWarmingCapForDay, LAST_FINITE_WARMING_CAP } from '@owlat/shared/warming';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: vi.fn().mockResolvedValue(true),
}));

/**
 * D19 regression guard: adding the per-provider dimension changes the SHAPE of
 * the cap, never the schedule that bounds it. The shipped per-UTC-day
 * idempotency guard and the published base schedule stay exactly as they were.
 */
describe('warming regression — schedule semantics are unchanged', () => {
	let redis: RealRedis;
	const ip = '10.0.0.13';
	const config = createTestConfig();
	const stateKey = warmingStateKey(ip);

	beforeEach(async () => {
		redis = new Redis() as unknown as RealRedis;
		// ioredis-mock reuses one keyspace across instances; without this the
		// no-send-day test reads the previous test's seeded volume.
		await redis.flushall();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-27T00:30:00.000Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * The COMPLETED previous UTC day — the window the provider dimension is
	 * evaluated against, because `today` is only ever a partial window when the
	 * hourly cron arms the guard.
	 */
	const YESTERDAY = '2026-07-26';

	async function seedCleanDay(sent: number): Promise<string> {
		await initializeWarming(redis, ip);
		const today = new Date().toISOString().split('T')[0]!;
		await redis.hset(stateKey, 'currentDay', '5', 'dailyCap', '700');
		await redis.hset(warmingDailyStatsKey(ip, today), 'sent', String(sent));
		return today;
	}

	it('advances the schedule EXACTLY once across 24 hourly calls in the same UTC date', async () => {
		const today = await seedCleanDay(700);
		// Provider stats present: the new dimension must not give the hourly cron a
		// second reason to advance the per-IP schedule.
		await redis.hset(warmingProviderDailyStatsKey(ip, 'gmail', YESTERDAY), 'sent', '700');

		for (let hour = 0; hour < 24; hour += 1) {
			vi.setSystemTime(new Date(`2026-07-27T${String(hour).padStart(2, '0')}:30:00.000Z`));
			await evaluateDay(redis, ip, config);
		}

		// One clean, fully-used day at schedule day 5 accelerates to day 7 and its
		// published cap — and stops there. Asserting the EXACT post-state is what
		// makes this a guard: a range would still pass if it advanced three times.
		const state = await getWarmingState(redis, ip);
		expect(state?.lastEvaluatedDate).toBe(today);
		expect(state?.currentDay).toBe(7);
		expect(state?.dailyCap).toBe(getWarmingCapForDay(7));
	});

	it('produces the same state from 24 calls as from a single call', async () => {
		await seedCleanDay(700);
		await redis.hset(warmingProviderDailyStatsKey(ip, 'gmail', YESTERDAY), 'sent', '700');
		await evaluateDay(redis, ip, config);
		const afterOne = await getWarmingState(redis, ip);
		for (let hour = 0; hour < 23; hour += 1) {
			await evaluateDay(redis, ip, config);
		}
		expect(await getWarmingState(redis, ip)).toEqual(afterOne);
	});

	it('keeps the published base schedule as a hard ceiling for the day it reaches', async () => {
		await seedCleanDay(700);
		await redis.hset(
			warmingProviderDailyStatsKey(ip, 'microsoft', YESTERDAY),
			'sent',
			'400',
			'deferred',
			'200'
		);
		await evaluateDay(redis, ip, config);
		const state = await getWarmingState(redis, ip);
		expect(state).not.toBeNull();
		const scheduled = getWarmingCapForDay(state!.currentDay);
		const ceiling = Number.isFinite(scheduled) ? scheduled : LAST_FINITE_WARMING_CAP;
		// A narrowed provider must never let the per-IP cap grow past the schedule.
		expect(state!.dailyCap).toBeLessThanOrEqual(ceiling);
		// ...and the narrowing itself lands on the provider, not on the schedule.
		expect(await redis.hget(warmingProviderStateKey(ip, 'microsoft'), 'capMultiplier')).toBe('0.5');
	});

	it('does not arm the guard on a no-send day, and evaluates no provider dimension either', async () => {
		await initializeWarming(redis, ip);
		// A COMPLETE previous provider day that WOULD tighten if it were read —
		// without it the provider half of this assertion proves nothing.
		await redis.hset(
			warmingProviderDailyStatsKey(ip, 'microsoft', YESTERDAY),
			'sent',
			'400',
			'deferred',
			'200'
		);

		await evaluateDay(redis, ip, config);

		const state = await getWarmingState(redis, ip);
		expect(state?.lastEvaluatedDate).toBe('');
		expect(state?.currentDay).toBe(1);
		// Zero per-IP sends returns BEFORE the provider call, so yesterday's
		// provider evaluation is deferred to the next day that sends anything —
		// no provider STATE key is created (the seeded daily-stats key is the only
		// `provider:` key in the space).
		expect(await redis.keys(`mta:warming:{warming:${ip}}:provider:*:state`)).toEqual([]);
	});

	/**
	 * D1/D19: the additive dimension must not make the AUTHORITATIVE schedule more
	 * fragile. The per-UTC-day guard is armed before the shipped cascade runs, so
	 * anything that throws before that cascade completes would cost this IP its
	 * whole day of schedule progress — including the critical HALT branch — with
	 * nothing to retry it. The provider evaluation therefore runs last and its
	 * failure is swallowed.
	 */
	it('advances the per-IP schedule exactly once even if the provider evaluation fails', async () => {
		const today = await seedCleanDay(700);
		await redis.hset(warmingProviderDailyStatsKey(ip, 'gmail', YESTERDAY), 'sent', '700');
		// Only the provider evaluation goes through a pipeline; the shipped
		// cascade issues plain commands.
		const pipeline = vi.spyOn(redis, 'pipeline').mockImplementation(() => {
			throw new Error('MOVED 1234 10.0.0.9:6379');
		});

		await expect(evaluateDay(redis, ip, config)).resolves.toBeUndefined();

		const state = await getWarmingState(redis, ip);
		expect(pipeline).toHaveBeenCalled();
		expect(state?.lastEvaluatedDate).toBe(today);
		expect(state?.currentDay).toBe(7);
		expect(state?.dailyCap).toBe(getWarmingCapForDay(7));

		// And the guard still holds for the rest of the day: the failure does not
		// buy the schedule a second advance either.
		pipeline.mockRestore();
		await evaluateDay(redis, ip, config);
		expect((await getWarmingState(redis, ip))?.currentDay).toBe(7);
	});

	it('advances again once the UTC date rolls over', async () => {
		const today = await seedCleanDay(700);
		await evaluateDay(redis, ip, config);
		const afterFirstDay = await getWarmingState(redis, ip);

		vi.setSystemTime(new Date('2026-07-28T00:30:00.000Z'));
		const tomorrow = new Date().toISOString().split('T')[0]!;
		expect(tomorrow).not.toBe(today);
		await redis.hset(warmingDailyStatsKey(ip, tomorrow), 'sent', '700');
		await evaluateDay(redis, ip, config);

		const afterSecondDay = await getWarmingState(redis, ip);
		expect(afterSecondDay!.currentDay).toBeGreaterThan(afterFirstDay!.currentDay);
		expect(afterSecondDay?.lastEvaluatedDate).toBe(tomorrow);
	});
});
