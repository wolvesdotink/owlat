import { describe, it, expect, beforeEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { classifySmtpResponse, type SmtpFailureCategory } from '../smtpClassifier.js';
import {
	isVolumePressureCategory,
	nextProviderCapMultiplier,
	pressureAdjustedDelayMs,
	PROVIDER_WARMING_POLICY,
} from '../warmingProviderPolicy.js';
import {
	evaluateProviderWarmingDay,
	readProviderVolumePressure,
	recordProviderVolumePressure,
} from '../warmingProviderStore.js';
import { warmingProviderDailyStatsKey, warmingProviderStateKey } from '../warmingKeys.js';
import { reduce, type DispatchOutcome } from '../../dispatch/outcome.js';
import type { AttemptCtx } from '../../dispatch/types.js';
import type { DestinationProviderKey, EmailJob } from '../../types.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Real 4xx text shapes, as the receivers actually word them. */
const PRESSURE_FIXTURES: ReadonlyArray<{
	name: string;
	provider: DestinationProviderKey;
	smtpCode: number;
	enhancedCode?: string;
	response: string;
	category: SmtpFailureCategory;
}> = [
	{
		name: 'Gmail 4.7.28 unusual rate',
		provider: 'gmail',
		smtpCode: 421,
		enhancedCode: '4.7.28',
		response:
			'421-4.7.28 Gmail has detected an unusual rate of unsolicited mail originating from your IP address.',
		category: 'gmail_rate_limited',
	},
	{
		name: 'Yahoo TS03 deferral',
		provider: 'yahoo',
		smtpCode: 421,
		response:
			'421 4.7.0 [TS03] All messages from 203.0.113.9 will be permanently deferred; Retrying will NOT succeed.',
		category: 'yahoo_ts03',
	},
	{
		name: 'Yahoo TSS04 extended deferral',
		provider: 'yahoo',
		smtpCode: 421,
		response: '421 4.7.0 [TSS04] Messages from 203.0.113.9 temporarily deferred',
		category: 'yahoo_tss04',
	},
	{
		name: 'Microsoft 4.3.2 resource throttle',
		provider: 'microsoft',
		smtpCode: 451,
		enhancedCode: '4.3.2',
		response: '451 4.3.2 The maximum number of concurrent server connections has exceeded a limit',
		category: 'microsoft_resource_throttle',
	},
	{
		name: 'generic rate limit',
		provider: 'other',
		smtpCode: 452,
		response: '452 4.5.3 Too many messages for this connection, please slow down',
		category: 'rate_limited',
	},
];

describe('deferral-aware retry', () => {
	let redis: RealRedis;
	const ip = '10.0.0.11';
	const utcDate = '2026-07-27';

	beforeEach(async () => {
		redis = new Redis() as unknown as RealRedis;
		// ioredis-mock shares its keyspace across instances; without this the
		// suites leak state into each other and the assertions stop meaning
		// anything.
		await redis.flushall();
	});

	describe('classifier verdicts that mean "volume pressure"', () => {
		for (const fixture of PRESSURE_FIXTURES) {
			it(`recognises ${fixture.name} as per-ISP volume pressure`, () => {
				const classification = classifySmtpResponse(
					fixture.smtpCode,
					fixture.response,
					fixture.enhancedCode,
					fixture.provider
				);
				expect(classification.category).toBe(fixture.category);
				expect(classification.retryable).toBe(true);
				expect(isVolumePressureCategory(classification.category)).toBe(true);
			});
		}

		it('does NOT treat greylisting or a full mailbox as volume pressure', () => {
			expect(
				isVolumePressureCategory(
					classifySmtpResponse(451, '451 4.7.1 Greylisted, try again later').category
				)
			).toBe(false);
			expect(
				isVolumePressureCategory(
					classifySmtpResponse(452, '452 4.2.2 Recipient mailbox is over quota').category
				)
			).toBe(false);
		});
	});

	describe('backoff lengthening', () => {
		it('leaves the suggested delay alone with no recent pressure', () => {
			expect(pressureAdjustedDelayMs(120_000, 0)).toBe(120_000);
		});

		it('doubles per recent pressure event, capped by the policy factor', () => {
			expect(pressureAdjustedDelayMs(60_000, 1)).toBe(120_000);
			expect(pressureAdjustedDelayMs(60_000, 2)).toBe(240_000);
			expect(pressureAdjustedDelayMs(60_000, 3)).toBe(480_000);
			expect(pressureAdjustedDelayMs(60_000, 30)).toBe(
				60_000 * PROVIDER_WARMING_POLICY.maximumBackoffFactor
			);
		});

		it('never exceeds the absolute retry ceiling', () => {
			expect(pressureAdjustedDelayMs(60 * 60_000, 10)).toBe(
				PROVIDER_WARMING_POLICY.maximumPressureRetryDelayMs
			);
		});

		it('is inert on hostile input', () => {
			expect(pressureAdjustedDelayMs(Number.NaN, 3)).toBe(0);
			expect(pressureAdjustedDelayMs(0, 3)).toBe(0);
			expect(pressureAdjustedDelayMs(60_000, Number.NaN)).toBe(60_000);
			expect(pressureAdjustedDelayMs(60_000, -4)).toBe(60_000);
		});
	});

	describe('the pressure loop through the dispatch reducer', () => {
		function makeCtx(provider: DestinationProviderKey, providerVolumePressure = 0): AttemptCtx {
			const job: EmailJob = {
				messageId: 'msg-pressure-1',
				to: 'user@example.com',
				from: 'sender@owlat.com',
				subject: 'Test',
				html: '<p>Hello</p>',
				ipPool: 'campaign',
				organizationId: 'org-1',
				dkimDomain: 'owlat.com',
			};
			return {
				job,
				domain: 'example.com',
				destination: {
					recipientDomain: 'example.com',
					providerKey: provider,
					throttleKey: provider,
					mx: {
						status: 'deliverable',
						source: 'mx',
						hosts: [{ exchange: 'mx.example.com', priority: 0 }],
					},
					daneDiscoveryAuthenticated: true,
				},
				fromDomain: 'owlat.com',
				pool: 'campaign',
				dedicatedIp: undefined,
				ip,
				eligibilityGeneration: 0,
				providerVolumePressure,
				durationMs: 42,
			};
		}

		function deferredOutcome(
			fixture: (typeof PRESSURE_FIXTURES)[number]
		): Extract<DispatchOutcome, { kind: 'deferred' }> {
			return {
				kind: 'deferred',
				smtpCode: fixture.smtpCode,
				error: fixture.response,
				enhancedCode: fixture.enhancedCode,
				classification: classifySmtpResponse(
					fixture.smtpCode,
					fixture.response,
					fixture.enhancedCode,
					fixture.provider
				),
			};
		}

		it('emits a per-provider pressure effect for a volume-pressure deferral', () => {
			const fixture = PRESSURE_FIXTURES[0]!;
			const { effects } = reduce(deferredOutcome(fixture), makeCtx(fixture.provider));
			expect(effects.map((effect) => effect.kind)).toContain('warming_provider_pressure');
			const pressure = effects.find((effect) => effect.kind === 'warming_provider_pressure');
			expect(pressure).toMatchObject({ ip, providerKey: 'gmail' });
		});

		it('emits no pressure effect for a non-pressure deferral', () => {
			const outcome: DispatchOutcome = {
				kind: 'deferred',
				smtpCode: 451,
				error: '451 4.7.1 Greylisted, try again later',
				enhancedCode: undefined,
				classification: classifySmtpResponse(451, 'Greylisted, try again later'),
			};
			const { effects } = reduce(outcome, makeCtx('other'));
			expect(effects.map((effect) => effect.kind)).not.toContain('warming_provider_pressure');
		});

		it('lengthens the defer delay while the destination is under pressure', () => {
			const fixture = PRESSURE_FIXTURES[3]!;
			const base = reduce(deferredOutcome(fixture), makeCtx(fixture.provider)).defer?.delayMs;
			const pressured = reduce(deferredOutcome(fixture), makeCtx(fixture.provider, 2)).defer
				?.delayMs;
			expect(base).toBe(20 * 60_000);
			expect(pressured).toBe(80 * 60_000);
		});

		it('mirrors every deferral into the per-provider warming dimension', () => {
			const fixture = PRESSURE_FIXTURES[1]!;
			const { effects } = reduce(deferredOutcome(fixture), makeCtx(fixture.provider));
			expect(
				effects.find((effect) => effect.kind === 'warming_record' && effect.result === 'deferral')
			).toMatchObject({ providerKey: 'yahoo' });
		});
	});

	describe('pressure feeds gate 2 (the per-provider cap)', () => {
		it('accumulates a bounded, readable pressure count per (IP x provider)', async () => {
			expect(await readProviderVolumePressure(redis, ip, 'microsoft')).toBe(0);
			for (let index = 0; index < 3; index += 1) {
				await recordProviderVolumePressure(
					redis,
					{ ip, provider: 'microsoft', utcDate },
					PROVIDER_WARMING_POLICY.pressureTtlSeconds
				);
			}
			expect(await readProviderVolumePressure(redis, ip, 'microsoft')).toBe(3);
			// Pressure on one provider says nothing about another.
			expect(await readProviderVolumePressure(redis, ip, 'gmail')).toBe(0);
		});

		it('tightens the provider cap on sustained pressure even when the rates look clean', async () => {
			const decision = nextProviderCapMultiplier(1, {
				sent: 5000,
				bounced: 0,
				deferred: 0,
				pressureEventsToday: PROVIDER_WARMING_POLICY.dailyPressureEventsForTighten,
			});
			expect(decision.verdict).toBe('tighten');
			expect(decision.capMultiplier).toBe(0.5);
		});

		it('holds (never recovers) while any pressure is on record', () => {
			expect(
				nextProviderCapMultiplier(0.5, {
					sent: 5000,
					bounced: 0,
					deferred: 0,
					pressureEventsToday: 1,
				})
			).toMatchObject({ verdict: 'hold', capMultiplier: 0.5 });
		});

		it('drives the recorded pressure into the daily evaluation', async () => {
			await redis.hset(
				warmingProviderDailyStatsKey(ip, 'microsoft', utcDate),
				'sent',
				'2000',
				'deferred',
				'0'
			);
			for (let index = 0; index < 4; index += 1) {
				await recordProviderVolumePressure(
					redis,
					{ ip, provider: 'microsoft', utcDate },
					PROVIDER_WARMING_POLICY.pressureTtlSeconds
				);
			}
			const evaluations = await evaluateProviderWarmingDay(redis, ip, utcDate);
			expect(evaluations.find((entry) => entry.provider === 'microsoft')?.decision.verdict).toBe(
				'tighten'
			);
			expect(await redis.hget(warmingProviderStateKey(ip, 'microsoft'), 'capMultiplier')).toBe(
				'0.5'
			);
		});
	});
});
