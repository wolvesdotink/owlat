import { describe, expect, it } from 'vitest';
import {
	brierBinary,
	brierMulticlass,
	cohensKappa,
	confusion,
	mean,
	quantile,
	reliability,
	thresholdForRecall,
	wilson,
	zeroFailureUpper95,
} from '../stats';

describe('wilson', () => {
	it('matches the textbook interval', () => {
		// 8 of 10: the Wilson 95% interval is [0.490, 0.943].
		const i = wilson(8, 10);
		expect(i.estimate).toBe(0.8);
		expect(i.low).toBeCloseTo(0.4902, 3);
		expect(i.high).toBeCloseTo(0.9433, 3);
	});

	it('stays inside [0, 1] at the edges and is null without trials', () => {
		const none = wilson(0, 20);
		expect(none.low).toBe(0);
		expect(none.high).toBeCloseTo(0.1611, 3);
		const all = wilson(20, 20);
		expect(all.high).toBe(1);
		expect(all.low).toBeCloseTo(0.8389, 3);
		expect(wilson(0, 0)).toEqual({ successes: 0, n: 0, estimate: null, low: null, high: null });
	});
});

describe('zeroFailureUpper95', () => {
	it('is the exact binomial bound, close to the rule of three', () => {
		expect(zeroFailureUpper95(30)).toBeCloseTo(0.095, 3);
		expect(zeroFailureUpper95(300)).toBeCloseTo(3 / 300, 3);
		expect(zeroFailureUpper95(0)).toBeNull();
	});
});

describe('brier', () => {
	it('scores binary forecasts', () => {
		expect(
			brierBinary([
				{ p: 1, y: true },
				{ p: 0, y: false },
			])
		).toBe(0);
		expect(
			brierBinary([
				{ p: 0.8, y: true },
				{ p: 0.4, y: false },
			])
		).toBeCloseTo((0.04 + 0.16) / 2, 10);
		expect(brierBinary([])).toBeNull();
	});

	it('scores a distribution over every option, missing options as zero', () => {
		expect(brierMulticlass([{ distribution: { a: 1, b: 0 }, label: 'a' }])).toBe(0);
		expect(brierMulticlass([{ distribution: { a: 0.5, b: 0.5 }, label: 'a' }])).toBeCloseTo(0.5);
		// The label's option is absent from the distribution: it counted as 0.
		expect(brierMulticlass([{ distribution: { a: 1 }, label: 'b' }])).toBe(2);
		expect(brierMulticlass([])).toBeNull();
	});
});

describe('reliability', () => {
	it('bins forecasts and weighs the calibration error by bin size', () => {
		const { bins, ece } = reliability(
			[
				{ p: 0.05, y: false },
				{ p: 0.15, y: false },
				{ p: 0.95, y: true },
				{ p: 1, y: false },
			],
			10
		);
		expect(bins).toHaveLength(10);
		expect(bins[0]).toMatchObject({ count: 1, meanPredicted: 0.05, observed: 0 });
		expect(bins[1]).toMatchObject({ count: 1, observed: 0 });
		// 1.0 lands in the last bin, not an eleventh.
		expect(bins[9]).toMatchObject({ count: 2, meanPredicted: 0.975, observed: 0.5 });
		expect(bins[5]).toMatchObject({ count: 0, meanPredicted: null, observed: null });
		expect(ece).toBeCloseTo((0.05 + 0.15 + 2 * 0.475) / 4, 10);
		expect(reliability([], 5).ece).toBeNull();
	});
});

describe('agreement', () => {
	it("computes Cohen's kappa against chance", () => {
		const pairs = [
			['a', 'a'],
			['a', 'a'],
			['b', 'b'],
			['b', 'a'],
		] as const;
		// observed 0.75; chance 0.5·0.75 + 0.5·0.25 = 0.5 → kappa 0.5.
		expect(cohensKappa(pairs)).toBeCloseTo(0.5, 10);
		expect(confusion(pairs)).toEqual({ a: { a: 2 }, b: { b: 1, a: 1 } });
		expect(cohensKappa([['a', 'a']])).toBeNull();
		expect(cohensKappa([])).toBeNull();
	});
});

describe('quantile, mean and threshold fitting', () => {
	it('uses nearest rank', () => {
		expect(quantile([3, 1, 2, 4], 0.5)).toBe(2);
		expect(quantile([3, 1, 2, 4], 0.95)).toBe(4);
		expect(quantile([], 0.5)).toBeNull();
		expect(mean([1, 2, 3])).toBe(2);
		expect(mean([])).toBeNull();
	});

	it('finds the highest threshold that keeps the target recall', () => {
		const points = [
			{ p: 0.9, y: true },
			{ p: 0.7, y: true },
			{ p: 0.3, y: true },
			{ p: 0.8, y: false },
		];
		expect(thresholdForRecall(points, 2 / 3)).toBe(0.7);
		expect(thresholdForRecall(points, 1)).toBe(0.3);
		expect(thresholdForRecall([{ p: 0.5, y: false }], 0.9)).toBeNull();
	});
});
