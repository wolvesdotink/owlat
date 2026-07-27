import { describe, it, expect, beforeEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import {
	recordProviderVolumePressure,
	recordProviderWarmingOutcome,
	recordProviderWarmingSend,
	evaluateProviderWarmingDay,
	providerCapVerdict,
	readProviderVolumePressure,
	readWarmingCapGateInputs,
} from '../warmingProviderStore.js';
import { resolveProviderCap } from './helpers/providerCapGate.js';
import {
	PROVIDER_DAILY_STATS_TTL_SECONDS,
	PROVIDER_STATE_TTL_SECONDS,
} from '../warmingProviderScripts.js';
import { PROVIDER_WARMING_POLICY } from '../warmingProviderPolicy.js';
import {
	warmingBulkDailyKey,
	warmingProviderDailyStatsKey,
	warmingProviderPressureKey,
	warmingProviderStateKey,
} from '../warmingKeys.js';
import type { DurableEffectIdentity } from '../../lib/effectCheckpoint.js';
import type { DestinationProviderKey } from '../../types.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * Redis discipline for the per-provider dimension: every new key carries a TTL,
 * every write is one atomic script, and no key set grows with traffic.
 */
describe('per-provider warming Redis discipline', () => {
	let redis: RealRedis;
	const ip = '10.0.0.15';
	const utcDate = '2026-07-27';

	beforeEach(async () => {
		redis = new Redis() as unknown as RealRedis;
		// `new Redis()` from ioredis-mock does NOT hand out a fresh keyspace, so
		// every one of these key-counting assertions would otherwise be reading
		// the previous test's leftovers.
		await redis.flushall();
	});

	function ref(provider: DestinationProviderKey, date = utcDate) {
		return { ip, provider, utcDate: date };
	}

	async function warmingKeys(): Promise<string[]> {
		return (await redis.keys(`mta:warming:{warming:${ip}}:*`)).sort();
	}

	it('sets a TTL on every key the send path creates', async () => {
		await recordProviderWarmingSend(redis, ref('gmail'), 'campaign');
		expect(await redis.ttl(warmingProviderStateKey(ip, 'gmail'))).toBe(PROVIDER_STATE_TTL_SECONDS);
		expect(await redis.ttl(warmingProviderDailyStatsKey(ip, 'gmail', utcDate))).toBe(
			PROVIDER_DAILY_STATS_TTL_SECONDS
		);
		expect(await redis.ttl(warmingBulkDailyKey(ip, utcDate))).toBe(
			PROVIDER_DAILY_STATS_TTL_SECONDS
		);
	});

	it('sets a TTL on every key the outcome and pressure paths create', async () => {
		await recordProviderWarmingOutcome(redis, ref('yahoo'), 'deferred');
		await recordProviderVolumePressure(
			redis,
			ref('yahoo'),
			PROVIDER_WARMING_POLICY.retryPressureWindowTtlSeconds
		);
		expect(await redis.ttl(warmingProviderDailyStatsKey(ip, 'yahoo', utcDate))).toBe(
			PROVIDER_DAILY_STATS_TTL_SECONDS
		);
		expect(await redis.ttl(warmingProviderPressureKey(ip, 'yahoo'))).toBe(
			PROVIDER_WARMING_POLICY.retryPressureWindowTtlSeconds
		);
	});

	it('creates no bulk key at all for transactional traffic', async () => {
		await recordProviderWarmingSend(redis, ref('gmail'), 'transactional');
		expect(await redis.exists(warmingBulkDailyKey(ip, utcDate))).toBe(0);
		expect((await readWarmingCapGateInputs(redis, ref('gmail'))).bulkSentToday).toBe(0);
	});

	it('refreshes rather than multiplies keys as traffic flows', async () => {
		for (let index = 0; index < 250; index += 1) {
			await recordProviderWarmingSend(redis, ref('gmail'), 'campaign');
		}
		// One state hash + one daily stats hash + one bulk counter, for this
		// (ip, provider, date) — regardless of how many messages flowed.
		expect(await warmingKeys()).toEqual([
			warmingBulkDailyKey(ip, utcDate),
			warmingProviderDailyStatsKey(ip, 'gmail', utcDate),
			warmingProviderStateKey(ip, 'gmail'),
		]);
		expect(await redis.hget(warmingProviderStateKey(ip, 'gmail'), 'sentToday')).toBe('250');
		expect((await readWarmingCapGateInputs(redis, ref('gmail'))).bulkSentToday).toBe(250);
	});

	it('bounds the key space by provider and by day, never by message', async () => {
		await recordProviderWarmingSend(redis, ref('gmail'), 'transactional');
		await recordProviderWarmingSend(redis, ref('microsoft'), 'transactional');
		await recordProviderWarmingSend(redis, ref('microsoft', '2026-07-28'), 'transactional');
		// gmail state + gmail day, microsoft state + two microsoft days.
		expect(await warmingKeys()).toHaveLength(5);
	});

	it('reads a cap without creating a key for a provider that has never sent', async () => {
		await resolveProviderCap(redis, ref('apple'), 500);
		expect(await redis.exists(warmingProviderStateKey(ip, 'apple'))).toBe(0);
		expect(await warmingKeys()).toEqual([]);
	});

	it('never WRITES on the hot cap-read path, not even to roll a stale day', async () => {
		// A live state hash whose counter belongs to a FINISHED day: the old read
		// script rolled it in place (an HSET + an EXPIRE on every dispatch attempt).
		await redis.hset(
			warmingProviderStateKey(ip, 'gmail'),
			'sentToday',
			'900',
			'sentTodayReset',
			'2026-07-20',
			'capMultiplier',
			'0.5'
		);
		await redis.expire(warmingProviderStateKey(ip, 'gmail'), 60);

		const gate = await resolveProviderCap(redis, ref('gmail'), 1000);

		// The stale counter reads as zero...
		expect(gate).toMatchObject({ sentToday: 0, capMultiplier: 0.5, allowed: true });
		// ...without the read having touched the row or its TTL.
		expect(await redis.hget(warmingProviderStateKey(ip, 'gmail'), 'sentToday')).toBe('900');
		expect(await redis.hget(warmingProviderStateKey(ip, 'gmail'), 'sentTodayReset')).toBe(
			'2026-07-20'
		);
		expect(await redis.ttl(warmingProviderStateKey(ip, 'gmail'))).toBe(60);
		// The next SEND is what rolls the day — the write path owns the reset.
		await recordProviderWarmingSend(redis, ref('gmail'), 'campaign');
		expect(await redis.hget(warmingProviderStateKey(ip, 'gmail'), 'sentToday')).toBe('1');
		expect(await redis.ttl(warmingProviderStateKey(ip, 'gmail'))).toBe(PROVIDER_STATE_TTL_SECONDS);
	});

	it('reads the whole cap-gate input set in one tick, without a pipeline object', async () => {
		await recordProviderWarmingSend(redis, ref('microsoft'), 'campaign');
		await recordProviderVolumePressure(
			redis,
			ref('microsoft'),
			PROVIDER_WARMING_POLICY.retryPressureWindowTtlSeconds
		);
		const before = await warmingKeys();
		// The three commands are issued in the SAME tick, which ioredis
		// auto-pipelines into one write to the socket. They must NOT go through
		// `redis.pipeline()`: this read runs on every dispatch attempt, and
		// coupling it to that object makes it collide with any unrelated caller
		// that stubs pipelines.
		const pipeline = vi.spyOn(redis, 'pipeline');

		const inputs = await readWarmingCapGateInputs(redis, ref('microsoft'));

		expect(pipeline).not.toHaveBeenCalled();
		expect(inputs.bulkSentToday).toBe(1);
		expect(inputs.volumePressure).toBe(1);
		expect(providerCapVerdict(inputs, 1000)).toMatchObject({ allowed: true, sentToday: 1 });
		// One read, and it created nothing.
		expect(await warmingKeys()).toEqual(before);
		pipeline.mockRestore();
	});

	it('degrades an ADVISORY read failure to exactly the shipped behaviour', async () => {
		// Gates 2 and 3 are advisory counters; the per-IP cap above them is the
		// authoritative gate. A Redis blip on this read must therefore never
		// withhold an attempt gate 1 would have allowed.
		const broken = {
			hmget: vi.fn().mockRejectedValue(new Error('READONLY')),
			get: vi.fn().mockRejectedValue(new Error('READONLY')),
		} as unknown as RealRedis;

		const inputs = await readWarmingCapGateInputs(broken, ref('gmail'));

		expect(inputs).toEqual({
			ref: ref('gmail'),
			providerState: [],
			bulkSentToday: 0,
			volumePressure: 0,
		});
		// The empty state resolves to the FULL per-IP cap — the degenerate case.
		expect(providerCapVerdict(inputs, 1000)).toEqual({
			allowed: true,
			sentToday: 0,
			capMultiplier: 1,
			providerCap: 1000,
		});
		// The narrow reservation-path read fails open the same way.
		expect(await readProviderVolumePressure(broken, ip, 'gmail')).toBe(0);
	});

	it('creates no key when the daily evaluation has nothing to evaluate', async () => {
		expect(await evaluateProviderWarmingDay(redis, ip, utcDate)).toEqual([]);
		expect(await warmingKeys()).toEqual([]);
	});

	it('keeps a replayed effect atomic: the receipt short-circuits the whole script', async () => {
		const identity = 'attempt-1:0:warming_record' as DurableEffectIdentity;
		await recordProviderWarmingSend(redis, ref('gmail'), 'campaign', identity);
		await recordProviderWarmingSend(redis, ref('gmail'), 'campaign', identity);
		await recordProviderWarmingSend(redis, ref('gmail'), 'campaign', identity);
		expect(await redis.hget(warmingProviderStateKey(ip, 'gmail'), 'sentToday')).toBe('1');
		expect(await redis.hget(warmingProviderDailyStatsKey(ip, 'gmail', utcDate), 'sent')).toBe('1');
		expect((await readWarmingCapGateInputs(redis, ref('gmail'))).bulkSentToday).toBe(1);
	});

	it('keeps a replayed deferral and a replayed pressure verdict counted once', async () => {
		const identity = 'attempt-2:3:warming_record' as DurableEffectIdentity;
		await recordProviderWarmingOutcome(redis, ref('microsoft'), 'deferred', identity);
		await recordProviderWarmingOutcome(redis, ref('microsoft'), 'deferred', identity);
		expect(
			await redis.hget(warmingProviderDailyStatsKey(ip, 'microsoft', utcDate), 'deferred')
		).toBe('1');

		const pressureIdentity = 'attempt-2:4:warming_provider_pressure' as DurableEffectIdentity;
		const first = await recordProviderVolumePressure(
			redis,
			ref('microsoft'),
			PROVIDER_WARMING_POLICY.retryPressureWindowTtlSeconds,
			pressureIdentity
		);
		const replay = await recordProviderVolumePressure(
			redis,
			ref('microsoft'),
			PROVIDER_WARMING_POLICY.retryPressureWindowTtlSeconds,
			pressureIdentity
		);
		expect(first).toBe(1);
		expect(replay).toBe(1);
		expect(
			await redis.hget(warmingProviderDailyStatsKey(ip, 'microsoft', utcDate), 'pressure')
		).toBe('1');
	});

	it('creates no receipt key when the caller has no durable identity', async () => {
		await recordProviderWarmingSend(redis, ref('gmail'), 'campaign');
		await recordProviderWarmingOutcome(redis, ref('gmail'), 'bounced');
		await recordProviderVolumePressure(
			redis,
			ref('gmail'),
			PROVIDER_WARMING_POLICY.retryPressureWindowTtlSeconds
		);
		expect((await warmingKeys()).filter((key) => key.includes(':effect:'))).toEqual([]);
	});

	it('expires the pressure counter so pressure is always a RECENT-history signal', () => {
		expect(PROVIDER_WARMING_POLICY.retryPressureWindowTtlSeconds).toBeGreaterThan(0);
		expect(PROVIDER_WARMING_POLICY.retryPressureWindowTtlSeconds).toBeLessThanOrEqual(24 * 60 * 60);
	});
});
