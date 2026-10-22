import { describe, expect, it } from 'vitest';
import { canRetry, nextDelay, type RetryPolicy } from '../retryPolicy';

const sequence = (policy: RetryPolicy, count: number, random?: () => number) =>
	Array.from({ length: count }, (_, index) => nextDelay(policy, index, undefined, random));

describe('nextDelay — the curve', () => {
	it('doubles from the base by default, indexed from zero', () => {
		expect(sequence({ baseMs: 250 }, 5)).toEqual([250, 500, 1_000, 2_000, 4_000]);
	});

	it('grows by the declared factor', () => {
		expect(sequence({ baseMs: 30_000, factor: 4 }, 4)).toEqual([
			30_000, 120_000, 480_000, 1_920_000,
		]);
	});

	it('stops at the cap and stays there, however far the index runs', () => {
		const policy = { baseMs: 60_000, capMs: 3_600_000 };
		expect(sequence(policy, 8)).toEqual([
			60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000,
		]);
		expect(nextDelay(policy, 5_000)).toBe(3_600_000);
	});

	it('is uncapped when no cap is declared', () => {
		expect(nextDelay({ baseMs: 1 }, 40)).toBe(1_099_511_627_776);
	});

	it('counts an index below zero as zero', () => {
		expect(nextDelay({ baseMs: 60_000, capMs: 3_600_000 }, -1)).toBe(60_000);
		expect(nextDelay({ baseMs: 60_000 }, -5)).toBe(60_000);
	});
});

describe('nextDelay — jitter', () => {
	const low = () => 0;
	const mid = () => 0.5;
	const high = () => 0.999;

	it('equal jitter keeps half the capped delay as a floor', () => {
		const policy: RetryPolicy = { baseMs: 250, capMs: 4_000, jitter: { kind: 'equal' } };
		expect(sequence(policy, 6, low)).toEqual([125, 250, 500, 1_000, 2_000, 2_000]);
		expect(sequence(policy, 6, mid)).toEqual([187.5, 375, 750, 1_500, 3_000, 3_000]);
		expect(nextDelay(policy, 9, undefined, high)).toBe(3_998);
	});

	it('equal jitter with rounding returns whole milliseconds', () => {
		const policy: RetryPolicy = {
			baseMs: 250,
			capMs: 4_000,
			jitter: { kind: 'equal' },
			round: true,
		};
		expect(sequence(policy, 2, mid)).toEqual([188, 375]);
	});

	it('spread scales the capped delay into [1 - ratio, 1 + ratio)', () => {
		const policy: RetryPolicy = {
			baseMs: 1_000,
			capMs: 8_000,
			jitter: { kind: 'spread', ratio: 0.2 },
			round: true,
		};
		expect(sequence(policy, 5, low)).toEqual([800, 1_600, 3_200, 6_400, 6_400]);
		expect(sequence(policy, 5, mid)).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
		// Jitter applies after the cap, so a spread delay may pass it.
		expect(nextDelay(policy, 4, undefined, high)).toBe(9_597);
	});

	it('upTo adds a whole-millisecond share of the capped delay on top', () => {
		const policy: RetryPolicy = {
			baseMs: 1_000,
			capMs: 30_000,
			jitter: { kind: 'upTo', ratio: 0.5 },
		};
		expect(sequence(policy, 6, low)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
		expect(sequence(policy, 2, high)).toEqual([1_499, 2_999]);
		expect(nextDelay(policy, 1, undefined, () => 0.3333)).toBe(2_333);
	});

	it('fixed adds up to maxMs whole milliseconds on top of the capped delay', () => {
		const policy: RetryPolicy = {
			baseMs: 5_000,
			capMs: 300_000,
			jitter: { kind: 'fixed', maxMs: 1_000 },
		};
		expect(sequence(policy, 8, low)).toEqual([
			5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
		]);
		expect(nextDelay(policy, 6, undefined, high)).toBe(300_999);
	});

	it('draws one random number per delay and none without jitter', () => {
		let draws = 0;
		const counted = () => {
			draws += 1;
			return 0.5;
		};
		nextDelay({ baseMs: 1_000 }, 3, undefined, counted);
		expect(draws).toBe(0);
		nextDelay({ baseMs: 1_000, jitter: { kind: 'equal' } }, 3, undefined, counted);
		expect(draws).toBe(1);
	});
});

describe('nextDelay — Retry-After', () => {
	it('is a floor: the longer of the curve and the hint wins', () => {
		const policy = { baseMs: 500 };
		expect(nextDelay(policy, 0, 2_000)).toBe(2_000);
		expect(nextDelay(policy, 3, 2_000)).toBe(4_000);
		expect(nextDelay(policy, 1, 0)).toBe(1_000);
	});

	it('applies after the cap, so a hint longer than the cap is honoured', () => {
		expect(nextDelay({ baseMs: 2_000, capMs: 30_000 }, 1, 45_000)).toBe(45_000);
	});

	it('applies after jitter and rounding', () => {
		const policy: RetryPolicy = {
			baseMs: 1_000,
			jitter: { kind: 'spread', ratio: 0.2 },
			round: true,
		};
		expect(nextDelay(policy, 0, 1_100, () => 0.999)).toBe(1_200);
		expect(nextDelay(policy, 0, 1_100, () => 0)).toBe(1_100);
	});
});

describe('canRetry', () => {
	it('allows another run while fewer than maxAttempts were made', () => {
		const policy = { baseMs: 200, maxAttempts: 3 };
		expect([1, 2, 3, 4].map((made) => canRetry(policy, made))).toEqual([true, true, false, false]);
	});

	it('never runs out without maxAttempts', () => {
		expect(canRetry({ baseMs: 200 }, 1_000_000)).toBe(true);
	});
});
