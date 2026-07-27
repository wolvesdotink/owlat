import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';

vi.mock('../warming.js', () => ({
	checkCap: vi.fn(),
	ensureWarmingReservation: vi.fn(),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	bulkDailyCeiling,
	evaluateIntradayPacing,
	INTRADAY_PACING_POLICY,
	pacedAllowance,
	utcDayElapsedFraction,
} from '../warmingPacing.js';
import * as warming from '../warming.js';
import { warmingCapPhase } from '../../dispatch/phases/warmingCap.js';
import { recordProviderWarmingSend } from '../warmingProviderStore.js';
import { warmingBulkDailyKey } from '../warmingKeys.js';
import type { CtxWithIp, PhaseDeps } from '../../dispatch/types.js';
import type { EmailJob, IpPoolType } from '../../types.js';
import type { MtaConfig } from '../../config.js';

const HOUR = 1 / 24;

describe('intraday pacing', () => {
	describe('spreading a campaign across the day', () => {
		it('does not let a large campaign empty the day cap in the first ten minutes', () => {
			const verdict = evaluateIntradayPacing({
				dailyCap: 20_000,
				bulkSentToday: 5_000,
				dayElapsedFraction: 10 / (24 * 60),
				pool: 'campaign',
			});
			expect(verdict.allowed).toBe(false);
			expect(verdict.reason).toBe('paced');
			expect(verdict.allowance).toBeLessThan(5_000);
			expect(verdict.retryAfterMs).toBeGreaterThanOrEqual(
				INTRADAY_PACING_POLICY.minimumPacingRetryDelayMs
			);
		});

		it('grows the allowance monotonically across the day and reaches the bulk ceiling', () => {
			const ceiling = bulkDailyCeiling(20_000);
			let previous = 0;
			for (let hour = 0; hour <= 24; hour += 1) {
				const allowance = pacedAllowance(ceiling, hour * HOUR);
				expect(allowance).toBeGreaterThanOrEqual(previous);
				previous = allowance;
			}
			expect(previous).toBe(ceiling);
		});

		it('allows a steady drip that stays under the curve', () => {
			const verdict = evaluateIntradayPacing({
				dailyCap: 20_000,
				bulkSentToday: 4_000,
				dayElapsedFraction: 0.5,
				pool: 'campaign',
			});
			expect(verdict).toMatchObject({ allowed: true, reason: 'within_pace' });
		});
	});

	describe('small campaigns are never stretched', () => {
		it('lets a 50-recipient campaign go out immediately on a day-1 cap', () => {
			const verdict = evaluateIntradayPacing({
				dailyCap: 50,
				bulkSentToday: 49,
				dayElapsedFraction: 0,
				pool: 'campaign',
			});
			expect(verdict).toMatchObject({ allowed: true, reason: 'small_volume' });
			expect(verdict.ceiling).toBe(50);
		});

		it('keeps the whole immediate-allowance floor available at the very start of the day', () => {
			expect(pacedAllowance(bulkDailyCeiling(120), 0)).toBe(
				INTRADAY_PACING_POLICY.immediateAllowanceFloor
			);
		});

		it('never reserves headroom out of a cap too small to spare it', () => {
			expect(bulkDailyCeiling(50)).toBe(50);
			expect(bulkDailyCeiling(100)).toBe(100);
			expect(bulkDailyCeiling(1500)).toBe(1200);
		});
	});

	describe('transactional traffic is never starved', () => {
		it('exempts transactional sends from pacing entirely', () => {
			const verdict = evaluateIntradayPacing({
				dailyCap: 20_000,
				bulkSentToday: 19_999,
				dayElapsedFraction: 0,
				pool: 'transactional',
			});
			expect(verdict).toMatchObject({ allowed: true, reason: 'transactional_exempt' });
		});

		it('holds a 20% safety headroom the bulk curve can never consume', () => {
			const dailyCap = 10_000;
			const ceiling = bulkDailyCeiling(dailyCap);
			expect(dailyCap - ceiling).toBe(
				dailyCap * INTRADAY_PACING_POLICY.transactionalHeadroomFraction
			);
			// Even at the end of the day the bulk pool stops at the ceiling.
			expect(
				evaluateIntradayPacing({
					dailyCap,
					bulkSentToday: ceiling,
					dayElapsedFraction: 1,
					pool: 'campaign',
				})
			).toMatchObject({ allowed: false, allowance: ceiling });
		});
	});

	describe('degenerate and hostile input', () => {
		it('treats a graduated (Infinity) cap as unpaced', () => {
			expect(
				evaluateIntradayPacing({
					dailyCap: Infinity,
					bulkSentToday: 1_000_000,
					dayElapsedFraction: 0,
					pool: 'campaign',
				})
			).toMatchObject({ allowed: true, reason: 'uncapped' });
		});

		it('fails open on NaN counters rather than stalling delivery', () => {
			expect(
				evaluateIntradayPacing({
					dailyCap: Number.NaN,
					bulkSentToday: Number.NaN,
					dayElapsedFraction: Number.NaN,
					pool: 'campaign',
				}).allowed
			).toBe(true);
			expect(
				evaluateIntradayPacing({
					dailyCap: 20_000,
					bulkSentToday: Number.NaN,
					dayElapsedFraction: 0.5,
					pool: 'campaign',
				})
			).toMatchObject({ allowed: true });
		});

		it('clamps a clock-skewed elapsed fraction into [0, 1]', () => {
			expect(utcDayElapsedFraction(Number.NaN)).toBe(0);
			expect(utcDayElapsedFraction(0)).toBe(0);
			expect(utcDayElapsedFraction(Date.UTC(2026, 6, 27, 12, 0, 0))).toBeCloseTo(0.5, 10);
			expect(pacedAllowance(1000, -5)).toBe(pacedAllowance(1000, 0));
			expect(pacedAllowance(1000, 99)).toBe(pacedAllowance(1000, 1));
		});

		it('clamps the retry delay to the policy window when the day is already spent', () => {
			const verdict = evaluateIntradayPacing({
				dailyCap: 20_000,
				bulkSentToday: 1_000_000,
				dayElapsedFraction: 0.99,
				pool: 'campaign',
			});
			expect(verdict.allowed).toBe(false);
			expect(verdict.retryAfterMs).toBe(INTRADAY_PACING_POLICY.maximumPacingRetryDelayMs);
		});

		it('never divides by a zero cap', () => {
			expect(
				evaluateIntradayPacing({
					dailyCap: 0,
					bulkSentToday: 0,
					dayElapsedFraction: 0.5,
					pool: 'campaign',
				})
			).toMatchObject({ allowed: true, reason: 'uncapped' });
		});
	});

	/**
	 * The pure function above is only half the claim. What actually ships is the
	 * warming-cap phase, and the counter IT feeds the curve is what decides
	 * whether a small campaign is stretched.
	 */
	describe('as wired into the warming-cap phase', () => {
		const IP = '10.0.0.21';
		const UTC_DATE = '2026-07-27';
		let redis: RealRedis;
		let deps: PhaseDeps;

		beforeEach(async () => {
			vi.clearAllMocks();
			vi.useFakeTimers();
			vi.setSystemTime(new Date(`${UTC_DATE}T00:10:00.000Z`));
			redis = new Redis() as unknown as RealRedis;
			await redis.flushall();
			deps = { redis, config: {} as MtaConfig };
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		function makeCtx(pool: IpPoolType): CtxWithIp {
			const job: EmailJob = {
				messageId: 'msg-pacing-1',
				to: 'user@example.com',
				from: 'sender@owlat.com',
				subject: 'Test',
				html: '<p>Hello</p>',
				ipPool: pool,
				organizationId: 'org-1',
				dkimDomain: 'owlat.com',
			};
			return {
				job,
				domain: 'example.com',
				destination: {
					recipientDomain: 'example.com',
					providerKey: 'gmail',
					throttleKey: 'example.com',
					mx: {
						status: 'deliverable',
						source: 'mx',
						hosts: [{ exchange: 'mx.example.com', priority: 0 }],
					},
					daneDiscoveryAuthenticated: true,
				},
				fromDomain: 'owlat.com',
				pool,
				dedicatedIp: undefined,
				ip: IP,
				eligibilityGeneration: 1,
			};
		}

		it('does not stretch a 50-recipient campaign behind 120 transactional sends', async () => {
			// dailyCap 1000, 120 transactional sends by 00:10 UTC. Against the
			// per-IP TOTAL the allowance (100) is already spent and every one of
			// the 50 campaign sends would defer; against the BULK counter it is 0.
			vi.mocked(warming.checkCap).mockResolvedValue({
				allowed: true,
				sentToday: 120,
				dailyCap: 1000,
			});
			for (let index = 0; index < 120; index += 1) {
				await recordProviderWarmingSend(
					redis,
					{ ip: IP, provider: 'gmail', utcDate: UTC_DATE },
					'transactional'
				);
			}

			for (let recipient = 0; recipient < 50; recipient += 1) {
				const out = await warmingCapPhase.run(deps, makeCtx('campaign'));
				expect(out.kind).toBe('continue');
				await recordProviderWarmingSend(
					redis,
					{ ip: IP, provider: 'gmail', utcDate: UTC_DATE },
					'campaign'
				);
			}
			expect(await redis.get(warmingBulkDailyKey(IP, UTC_DATE))).toBe('50');
		});

		it('still paces a genuinely large campaign on the same IP', async () => {
			vi.mocked(warming.checkCap).mockResolvedValue({
				allowed: true,
				sentToday: 900,
				dailyCap: 1000,
			});
			await redis.set(warmingBulkDailyKey(IP, UTC_DATE), '800');

			const out = await warmingCapPhase.run(deps, makeCtx('campaign'));

			expect(out.kind).toBe('defer');
		});

		it('never starves transactional traffic behind a saturated bulk curve', async () => {
			vi.mocked(warming.checkCap).mockResolvedValue({
				allowed: true,
				sentToday: 800,
				dailyCap: 1000,
			});
			await redis.set(warmingBulkDailyKey(IP, UTC_DATE), '800');

			const out = await warmingCapPhase.run(deps, makeCtx('transactional'));

			expect(out.kind).toBe('continue');
		});
	});
});
