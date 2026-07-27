import { describe, it, expect } from 'vitest';
import {
	bulkDailyCeiling,
	evaluateIntradayPacing,
	INTRADAY_PACING_POLICY,
	pacedAllowance,
	utcDayElapsedFraction,
} from '../warmingPacing.js';
import { ADAPTIVE_WARMING_POLICY } from '@owlat/shared/warming';

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

		// 343 is not incidental: it is 700 after two 0.7 decelerations, and
		// 0.2 * 343 is not an integer. Rounding the headroom UP there would put
		// the ceiling at 274/343 = 0.7988 — below the shipped acceleration gate's
		// usageRateMinimum — and silently disable acceleration for a bulk-only IP.
		it.each([10_000, 343, 50, 7, 3])(
			'holds a 20%% safety headroom the bulk curve can never consume (cap %i)',
			(dailyCap) => {
				const ceiling = bulkDailyCeiling(dailyCap);
				expect(dailyCap - ceiling).toBeGreaterThanOrEqual(0);
				expect(dailyCap - ceiling).toBeLessThanOrEqual(
					dailyCap * INTRADAY_PACING_POLICY.transactionalHeadroomFraction
				);
				// The ceiling must stay REACHABLE by the shipped acceleration gate:
				// a bulk-only IP sending exactly its ceiling still clears 0.8.
				expect(ceiling / dailyCap).toBeGreaterThanOrEqual(
					ADAPTIVE_WARMING_POLICY.acceleration.usageRateMinimum
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
			}
		);

		it('reserves an exact fifth of a cap that divides evenly', () => {
			expect(10_000 - bulkDailyCeiling(10_000)).toBe(
				10_000 * INTRADAY_PACING_POLICY.transactionalHeadroomFraction
			);
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

	// The phase-WIRING half of the claim — that the curve is fed the BULK counter
	// and not the per-IP total — lives in the phase's own suite,
	// apps/mta/src/dispatch/phases/__tests__/warmingCap.test.ts ('gate 3 —
	// intraday pacing'). One ctx/ioredis-mock fixture, in the suite that owns it.
});
