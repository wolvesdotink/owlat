import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { checkCap, getWarmingState, recordSend, reserveWarmingSlot } from '../warming.js';
import { checkProviderCap, recordProviderWarmingSend } from '../warmingProviderStore.js';
import {
	warmingProviderDailyStatsKey,
	warmingProviderStateKey,
	warmingStateKey,
	warmingDailyStatsKey,
} from '../warmingKeys.js';
import { WARMING_PROVIDER_STATE_CODEC_VERSION } from '../warmingStateCodec.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: vi.fn().mockResolvedValue(true),
}));

/**
 * The per-provider dimension EXTENDS the shipped key scheme. A deployment that
 * upgrades mid-warming must keep its existing per-IP state, its counters, and
 * its schedule position — the new dimension only fills in from the next send.
 */
describe('warming key/codec migration', () => {
	let redis: RealRedis;
	const ip = '10.0.0.9';
	// Pinned, not read from the real clock: a suite whose expectations depend on
	// `new Date()` at describe scope is flaky across a UTC midnight boundary.
	const today = '2026-07-27';

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(`${today}T09:00:00.000Z`));
		redis = new Redis() as unknown as RealRedis;
		// ioredis-mock shares one keyspace across instances; without this the
		// suite leaks state between tests.
		await redis.flushall();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** Exactly the hash a pre-upgrade MTA leaves behind mid-ramp. */
	async function seedLegacyPerIpState(): Promise<void> {
		await redis.hset(
			warmingStateKey(ip),
			'startedAt',
			'1750000000000',
			'currentDay',
			'7',
			'dailyCap',
			'1500',
			'sentToday',
			'400',
			'sentTodayReset',
			today,
			'lastEvaluatedDate',
			'',
			'bounceRate',
			'0',
			'deferralRate',
			'0',
			'phase',
			'ramp'
		);
	}

	it('keeps a legacy per-IP row readable and enforceable with no provider state present', async () => {
		await seedLegacyPerIpState();
		const state = await getWarmingState(redis, ip);
		expect(state).toMatchObject({ currentDay: 7, dailyCap: 1500, sentToday: 400, phase: 'ramp' });
		expect(await checkCap(redis, ip)).toEqual({
			allowed: true,
			sentToday: 400,
			dailyCap: 1500,
		});
	});

	it('resolves the per-provider cap from the legacy per-IP cap without a reset', async () => {
		await seedLegacyPerIpState();
		const gmail = await checkProviderCap(redis, { ip, provider: 'gmail', utcDate: today }, 1500);
		expect(gmail).toMatchObject({ allowed: true, sentToday: 0, providerCap: 1500 });
		// Reading the provider dimension must not have touched the per-IP row.
		expect(await redis.hget(warmingStateKey(ip), 'sentToday')).toBe('400');
		expect(await redis.exists(warmingProviderStateKey(ip, 'gmail'))).toBe(0);
	});

	it('fills the new dimension in on the next send while the per-IP counters keep counting', async () => {
		await seedLegacyPerIpState();
		await recordSend(redis, ip);
		await recordProviderWarmingSend(redis, { ip, provider: 'gmail', utcDate: today }, 'campaign');

		expect(await redis.hget(warmingStateKey(ip), 'sentToday')).toBe('401');
		expect(await redis.hget(warmingDailyStatsKey(ip, today), 'sent')).toBe('1');
		expect(await redis.hget(warmingProviderStateKey(ip, 'gmail'), 'sentToday')).toBe('1');
		expect(await redis.hget(warmingProviderDailyStatsKey(ip, 'gmail', today), 'sent')).toBe('1');
		expect(await redis.hget(warmingProviderStateKey(ip, 'gmail'), 'codecVersion')).toBe(
			String(WARMING_PROVIDER_STATE_CODEC_VERSION)
		);
	});

	it('leaves the shipped reservation key shape and semantics untouched', async () => {
		await seedLegacyPerIpState();
		const reserved = await reserveWarmingSlot(redis, ip, 'msg-legacy-1');
		expect(reserved).toMatchObject({ allowed: true, sentToday: 400, dailyCap: 1500 });
		expect(reserved.reservation).toMatchObject({ ip, messageId: 'msg-legacy-1' });
		expect(
			await redis.zscore(`mta:warming:{warming:${ip}}:reservations:${today}`, 'msg-legacy-1')
		).not.toBeNull();

		// Recording the new dimension must not disturb the reservation zset: an
		// attempt that holds a reservation owns its slot, and the warming-cap
		// phase short-circuits for it before any of the new gates run.
		await recordProviderWarmingSend(redis, { ip, provider: 'gmail', utcDate: today }, 'campaign');
		expect(
			await redis.zscore(`mta:warming:{warming:${ip}}:reservations:${today}`, 'msg-legacy-1')
		).not.toBeNull();
		expect(await redis.hget(warmingStateKey(ip), 'sentToday')).toBe('400');
	});

	it('rolls the provider day independently without resetting the per-IP day', async () => {
		await seedLegacyPerIpState();
		await redis.hset(
			warmingProviderStateKey(ip, 'yahoo'),
			'sentToday',
			'25',
			'sentTodayReset',
			'2020-01-01',
			'capMultiplier',
			'0.5'
		);
		const yahoo = await checkProviderCap(redis, { ip, provider: 'yahoo', utcDate: today }, 1500);
		expect(yahoo.sentToday).toBe(0);
		expect(yahoo.capMultiplier).toBe(0.5);
		expect(await redis.hget(warmingStateKey(ip), 'sentToday')).toBe('400');
	});

	it('treats a provider row written by an older codec as defaults, not as an error', async () => {
		await redis.hset(
			warmingProviderStateKey(ip, 'apple'),
			'sentToday',
			'3',
			'sentTodayReset',
			today
		);
		const apple = await checkProviderCap(redis, { ip, provider: 'apple', utcDate: today }, 800);
		expect(apple).toMatchObject({
			allowed: true,
			sentToday: 3,
			capMultiplier: 1,
			providerCap: 800,
		});
	});
});
