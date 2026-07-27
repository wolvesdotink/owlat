import { describe, it, expect, beforeEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { checkCap, initializeWarming, recordSend } from '../warming.js';
import {
	checkProviderCap,
	recordProviderWarmingSend,
	evaluateProviderWarmingDay,
} from '../warmingProviderStore.js';
import {
	effectiveProviderCap,
	nextProviderCapMultiplier,
	normalizeCapMultiplier,
	PROVIDER_WARMING_POLICY,
	type ProviderCapVerdict,
	type ProviderWarmingWindow,
} from '../warmingProviderPolicy.js';
import {
	warmingProviderDailyStatsKey,
	warmingProviderStateKey,
	warmingStateKey,
} from '../warmingKeys.js';
import type { DestinationProviderKey } from '../../types.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: vi.fn().mockResolvedValue(true),
}));

describe('per-(IP x mailbox provider) warming caps', () => {
	let redis: RealRedis;
	const ip = '10.0.0.7';
	const utcDate = '2026-07-27';
	const stateKey = warmingStateKey(ip);

	beforeEach(async () => {
		redis = new Redis() as unknown as RealRedis;
		// ioredis-mock hands every instance the SAME keyspace, so a fresh
		// `new Redis()` is NOT a fresh database. Without this the suite is
		// order-dependent and its assertions stop meaning anything.
		await redis.flushall();
	});

	function ref(provider: DestinationProviderKey) {
		return { ip, provider, utcDate };
	}

	async function seedIpCap(dailyCap: number): Promise<void> {
		await initializeWarming(redis, ip);
		await redis.hset(stateKey, 'dailyCap', String(dailyCap), 'sentTodayReset', utcDate);
	}

	async function narrowProvider(
		provider: DestinationProviderKey,
		capMultiplier: number,
		cleanStreak = 0
	): Promise<void> {
		await redis.hset(
			warmingProviderStateKey(ip, provider),
			'capMultiplier',
			String(capMultiplier),
			'cleanStreak',
			String(cleanStreak),
			'sentToday',
			'0',
			'sentTodayReset',
			utcDate
		);
	}

	it('gives an untouched provider the full per-IP cap (shipped behaviour is the degenerate case)', async () => {
		await seedIpCap(1000);
		const gmail = await checkProviderCap(redis, ref('gmail'), 1000);
		expect(gmail).toMatchObject({ allowed: true, sentToday: 0, providerCap: 1000 });
		expect(gmail.capMultiplier).toBe(PROVIDER_WARMING_POLICY.defaultCapMultiplier);
	});

	it('lets an IP stay TRUSTED AT GOOGLE while CRAWLING AT MICROSOFT', async () => {
		await seedIpCap(1000);
		await narrowProvider('microsoft', 0.05);

		expect((await checkProviderCap(redis, ref('gmail'), 1000)).providerCap).toBe(1000);
		expect((await checkProviderCap(redis, ref('microsoft'), 1000)).providerCap).toBe(50);

		for (let index = 0; index < 50; index += 1) {
			await recordProviderWarmingSend(redis, ref('microsoft'), 'campaign');
		}
		expect(await checkProviderCap(redis, ref('microsoft'), 1000)).toMatchObject({
			allowed: false,
			sentToday: 50,
		});
		// Microsoft crawling must not cost Google a single send.
		expect(await checkProviderCap(redis, ref('gmail'), 1000)).toMatchObject({
			allowed: true,
			sentToday: 0,
		});
	});

	it('keeps the caps independent per provider dimension', async () => {
		await seedIpCap(1000);
		await narrowProvider('yahoo', 0.1);
		for (let index = 0; index < 40; index += 1) {
			await recordProviderWarmingSend(redis, ref('yahoo'), 'campaign');
		}
		expect((await checkProviderCap(redis, ref('yahoo'), 1000)).sentToday).toBe(40);
		expect((await checkProviderCap(redis, ref('apple'), 1000)).sentToday).toBe(0);
		expect((await checkProviderCap(redis, ref('other'), 1000)).sentToday).toBe(0);
	});

	it('never lets the union of provider sends exceed the per-IP daily cap', async () => {
		const dailyCap = 120;
		await seedIpCap(dailyCap);
		const providers: DestinationProviderKey[] = ['gmail', 'microsoft', 'yahoo', 'apple', 'other'];
		let accepted = 0;
		// Every provider believes it may use the whole per-IP cap; the authoritative
		// per-IP counter is what actually bounds the union.
		for (let attempt = 0; attempt < dailyCap * providers.length; attempt += 1) {
			const provider = providers[attempt % providers.length]!;
			const ipGate = await checkCap(redis, ip);
			if (!ipGate.allowed) break;
			const providerGate = await checkProviderCap(redis, ref(provider), ipGate.dailyCap);
			if (!providerGate.allowed) continue;
			await recordSend(redis, ip);
			await recordProviderWarmingSend(redis, ref(provider), 'campaign');
			accepted += 1;
		}
		expect(accepted).toBe(dailyCap);
		expect(Number(await redis.hget(stateKey, 'sentToday'))).toBe(dailyCap);
	});

	describe('effectiveProviderCap — every branch it can return', () => {
		const cases: ReadonlyArray<{
			name: string;
			dailyCap: number;
			multiplier: number;
			expected: number;
		}> = [
			{
				name: 'multiplier >= 1 leaves the per-IP cap untouched',
				dailyCap: 1000,
				multiplier: 1,
				expected: 1000,
			},
			{
				name: 'a corrupt multiplier above 1 clamps to the per-IP cap',
				dailyCap: 1000,
				multiplier: 4,
				expected: 1000,
			},
			{
				name: 'a mid-range multiplier narrows proportionally',
				dailyCap: 1000,
				multiplier: 0.5,
				expected: 500,
			},
			{
				name: 'a rounded multiplier floors to a whole number of sends',
				dailyCap: 1000,
				multiplier: 0.35,
				expected: 350,
			},
			{
				name: 'the minimumCapMultiplier floor still yields a real cap',
				dailyCap: 1000,
				multiplier: PROVIDER_WARMING_POLICY.minimumCapMultiplier,
				expected: 50,
			},
			{
				name: 'a multiplier below the floor is clamped to the floor',
				dailyCap: 1000,
				multiplier: 0.0001,
				expected: 50,
			},
			{
				name: 'the minimumProviderCap clamp keeps a trickle on a tiny cap',
				dailyCap: 3,
				multiplier: 0.05,
				expected: PROVIDER_WARMING_POLICY.minimumProviderCap,
			},
			{
				name: 'a graduated (Infinity) cap stays uncapped for every provider',
				dailyCap: Infinity,
				multiplier: 0.05,
				expected: Infinity,
			},
			{
				name: 'a zero cap yields the minimum provider cap, never a negative one',
				dailyCap: 0,
				multiplier: 0.5,
				expected: PROVIDER_WARMING_POLICY.minimumProviderCap,
			},
			{
				name: 'a NaN cap is treated as uncapped rather than as zero',
				dailyCap: Number.NaN,
				multiplier: 0.5,
				expected: Infinity,
			},
		];

		for (const testCase of cases) {
			it(testCase.name, () => {
				expect(effectiveProviderCap(testCase.dailyCap, testCase.multiplier)).toBe(
					testCase.expected
				);
			});
		}
	});

	it('clamps a hostile or corrupt persisted multiplier into the policy domain', () => {
		expect(normalizeCapMultiplier('not-a-number')).toBe(1);
		expect(normalizeCapMultiplier(undefined)).toBe(1);
		expect(normalizeCapMultiplier('')).toBe(1);
		expect(normalizeCapMultiplier(9999)).toBe(1);
		expect(normalizeCapMultiplier(-5)).toBe(PROVIDER_WARMING_POLICY.minimumCapMultiplier);
		expect(normalizeCapMultiplier(0)).toBe(PROVIDER_WARMING_POLICY.minimumCapMultiplier);
	});

	it('rounds at the write boundary so a multiplier can never accumulate float drift', () => {
		// 0.25 + 0.1 is 0.35000000000000003 in IEEE-754.
		expect(normalizeCapMultiplier(0.25 + 0.1)).toBe(0.35);
		let multiplier = 0.05;
		for (let promotion = 0; promotion < 20; promotion += 1) {
			multiplier = normalizeCapMultiplier(multiplier + PROVIDER_WARMING_POLICY.recoveryStep);
			// A drifted value stringifies to 18 characters; a rounded one to <= 4.
			expect(String(multiplier).length).toBeLessThanOrEqual(4);
		}
		expect(multiplier).toBe(1);
	});

	describe('nextProviderCapMultiplier — the D9/D10 gates, as a fixture table', () => {
		const MIN = PROVIDER_WARMING_POLICY.minimumSampleSends;
		const K = PROVIDER_WARMING_POLICY.cleanDaysForRecovery;
		const clean = (sent: number): ProviderWarmingWindow => ({
			sent,
			bounced: 0,
			deferred: 0,
			pressureEventsToday: 0,
		});

		const cases: ReadonlyArray<{
			name: string;
			current: number;
			window: ProviderWarmingWindow;
			cleanStreak: number;
			verdict: ProviderCapVerdict;
			capMultiplier: number;
			nextStreak: number;
		}> = [
			{
				name: 'a zero-volume day is insufficient data',
				current: 0.5,
				window: { sent: 0, bounced: 0, deferred: 0, pressureEventsToday: 9 },
				cleanStreak: 2,
				verdict: 'insufficient_data',
				capMultiplier: 0.5,
				nextStreak: 2,
			},
			{
				name: 'a single bounced message does NOT tighten (below minimum sample)',
				current: 0.5,
				window: { sent: 1, bounced: 1, deferred: 0, pressureEventsToday: 0 },
				cleanStreak: 0,
				verdict: 'insufficient_data',
				capMultiplier: 0.5,
				nextStreak: 0,
			},
			{
				name: 'a single clean message does NOT recover (below minimum sample)',
				current: 0.5,
				window: clean(1),
				cleanStreak: K,
				verdict: 'insufficient_data',
				capMultiplier: 0.5,
				nextStreak: K,
			},
			{
				name: 'one send short of the minimum still holds everything',
				current: 0.5,
				window: { sent: MIN - 1, bounced: MIN - 1, deferred: 0, pressureEventsToday: 0 },
				cleanStreak: 0,
				verdict: 'insufficient_data',
				capMultiplier: 0.5,
				nextStreak: 0,
			},
			{
				name: 'exactly the minimum sample lets the gate speak',
				current: 1,
				window: { sent: MIN, bounced: MIN, deferred: 0, pressureEventsToday: 0 },
				cleanStreak: 0,
				verdict: 'tighten',
				capMultiplier: 0.5,
				nextStreak: 0,
			},
			{
				name: 'a bounce-rate breach tightens x0.5 and resets the streak',
				current: 0.8,
				window: { sent: 1000, bounced: 40, deferred: 0, pressureEventsToday: 0 },
				cleanStreak: 2,
				verdict: 'tighten',
				capMultiplier: 0.4,
				nextStreak: 0,
			},
			{
				name: 'a deferral-rate breach tightens too',
				current: 1,
				window: { sent: 100, bounced: 0, deferred: 40, pressureEventsToday: 0 },
				cleanStreak: 0,
				verdict: 'tighten',
				capMultiplier: 0.5,
				nextStreak: 0,
			},
			{
				name: 'sustained volume pressure tightens on its own',
				current: 1,
				window: {
					sent: 5000,
					bounced: 0,
					deferred: 0,
					pressureEventsToday: PROVIDER_WARMING_POLICY.dailyPressureEventsForTighten,
				},
				cleanStreak: 5,
				verdict: 'tighten',
				capMultiplier: 0.5,
				nextStreak: 0,
			},
			{
				name: 'tightening never falls below the minimum multiplier',
				current: PROVIDER_WARMING_POLICY.minimumCapMultiplier,
				window: { sent: 1000, bounced: 500, deferred: 0, pressureEventsToday: 0 },
				cleanStreak: 0,
				verdict: 'tighten',
				capMultiplier: PROVIDER_WARMING_POLICY.minimumCapMultiplier,
				nextStreak: 0,
			},
			{
				name: 'one clean day only banks a streak — it does not widen the cap',
				current: 0.25,
				window: clean(500),
				cleanStreak: 0,
				verdict: 'hold',
				capMultiplier: 0.25,
				nextStreak: 1,
			},
			{
				name: 'two clean days still only bank the streak',
				current: 0.25,
				window: clean(500),
				cleanStreak: 1,
				verdict: 'hold',
				capMultiplier: 0.25,
				nextStreak: 2,
			},
			{
				name: 'the Kth consecutive clean day recovers +0.1 and resets the streak',
				current: 0.25,
				window: clean(500),
				cleanStreak: K - 1,
				verdict: 'recover',
				capMultiplier: 0.35,
				nextStreak: 0,
			},
			{
				name: 'a middling day breaks the streak without retreating',
				current: 0.25,
				window: { sent: 1000, bounced: 20, deferred: 0, pressureEventsToday: 0 },
				cleanStreak: K - 1,
				verdict: 'hold',
				capMultiplier: 0.25,
				nextStreak: 0,
			},
			{
				name: 'any pressure at all breaks the streak',
				current: 0.25,
				window: { sent: 1000, bounced: 0, deferred: 0, pressureEventsToday: 1 },
				cleanStreak: K - 1,
				verdict: 'hold',
				capMultiplier: 0.25,
				nextStreak: 0,
			},
			{
				name: 'an already-unrestricted provider holds at 1 forever',
				current: 1,
				window: clean(5000),
				cleanStreak: K,
				verdict: 'hold',
				capMultiplier: 1,
				nextStreak: 0,
			},
			{
				name: 'recovery never overshoots the unrestricted default',
				current: 0.95,
				window: clean(5000),
				cleanStreak: K - 1,
				verdict: 'recover',
				capMultiplier: 1,
				nextStreak: 0,
			},
		];

		for (const testCase of cases) {
			it(testCase.name, () => {
				const decision = nextProviderCapMultiplier(
					testCase.current,
					testCase.window,
					testCase.cleanStreak
				);
				expect(decision.verdict).toBe(testCase.verdict);
				expect(decision.capMultiplier).toBe(testCase.capMultiplier);
				expect(decision.cleanStreak).toBe(testCase.nextStreak);
			});
		}

		it('reports the sample it had and the sample it needed on insufficient data', () => {
			expect(nextProviderCapMultiplier(0.5, clean(7))).toEqual({
				verdict: 'insufficient_data',
				capMultiplier: 0.5,
				cleanStreak: 0,
				have: 7,
				need: MIN,
			});
		});
	});

	it('tightens only the provider whose own outcomes went bad', async () => {
		await redis.hset(
			warmingProviderDailyStatsKey(ip, 'microsoft', utcDate),
			'sent',
			'100',
			'deferred',
			'40'
		);
		await redis.hset(
			warmingProviderDailyStatsKey(ip, 'gmail', utcDate),
			'sent',
			'100',
			'deferred',
			'0',
			'bounced',
			'0'
		);

		const evaluations = await evaluateProviderWarmingDay(redis, ip, utcDate);
		const microsoft = evaluations.find((entry) => entry.provider === 'microsoft');
		const gmail = evaluations.find((entry) => entry.provider === 'gmail');
		expect(microsoft?.decision.verdict).toBe('tighten');
		expect(microsoft?.decision.capMultiplier).toBe(0.5);
		// Gmail banks a clean day; its cap does not move.
		expect(gmail?.decision.verdict).toBe('hold');
		expect(gmail?.decision.capMultiplier).toBe(1);
		expect(await redis.hget(warmingProviderStateKey(ip, 'microsoft'), 'capMultiplier')).toBe('0.5');
		// Nothing moved for gmail, so no key was written for it at all.
		expect(await redis.exists(warmingProviderStateKey(ip, 'gmail'))).toBe(0);
	});

	it('recovers a narrowed provider additively only after a full clean streak', async () => {
		await narrowProvider('microsoft', 0.25, PROVIDER_WARMING_POLICY.cleanDaysForRecovery - 1);
		await redis.hset(
			warmingProviderDailyStatsKey(ip, 'microsoft', utcDate),
			'sent',
			'500',
			'deferred',
			'0',
			'bounced',
			'0'
		);
		const evaluations = await evaluateProviderWarmingDay(redis, ip, utcDate);
		const microsoft = evaluations.find((entry) => entry.provider === 'microsoft');
		expect(microsoft?.decision.verdict).toBe('recover');
		// Exact, not approximate: the multiplier is rounded at the write boundary.
		expect(microsoft?.decision.capMultiplier).toBe(0.35);
		expect(await redis.hget(warmingProviderStateKey(ip, 'microsoft'), 'capMultiplier')).toBe(
			'0.35'
		);
	});

	it('does not widen a narrowed provider on its first clean day', async () => {
		await narrowProvider('microsoft', 0.25);
		await redis.hset(
			warmingProviderDailyStatsKey(ip, 'microsoft', utcDate),
			'sent',
			'500',
			'deferred',
			'0',
			'bounced',
			'0'
		);
		const evaluations = await evaluateProviderWarmingDay(redis, ip, utcDate);
		expect(evaluations.find((entry) => entry.provider === 'microsoft')?.decision.verdict).toBe(
			'hold'
		);
		expect(await redis.hget(warmingProviderStateKey(ip, 'microsoft'), 'capMultiplier')).toBe(
			'0.25'
		);
		expect(await redis.hget(warmingProviderStateKey(ip, 'microsoft'), 'cleanStreak')).toBe('1');
	});
});
