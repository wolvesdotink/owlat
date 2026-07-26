import { describe, it, expect } from 'vitest';
import {
	EMPTY_ENGAGEMENT_STATE,
	computeEngagementScore,
	decayState,
	engagementBand,
	engagementPercentile,
	scoreFromState,
	type EngagementActivity,
	type EngagementScoreState,
} from '../engagementScore';

/**
 * Hostile and degenerate inputs to the engagement score (deliverability plan
 * P0-2). The score is written into a contact row and read by the MTA's priority
 * bands, so a NaN or a negative here is not a cosmetic bug — it corrupts the
 * queue ordering for the whole book.
 *
 * Every case asserts the same floor: a finite integer in [0, 100].
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

function expectSane(score: number): void {
	expect(Number.isFinite(score)).toBe(true);
	expect(Number.isInteger(score)).toBe(true);
	expect(score).toBeGreaterThanOrEqual(0);
	expect(score).toBeLessThanOrEqual(100);
}

describe('degenerate timelines', () => {
	it('handles an empty activity list', () => {
		const result = computeEngagementScore({
			activities: [],
			tenureStartedAt: NOW - 500 * DAY,
			now: NOW,
		});
		expectSane(result.score);
		expect(result.score).toBe(0);
		expect(engagementBand(result.score)).toBe('cold');
		expect(result.inputs.openCount).toBe(0);
	});

	it('handles a contact created in the same millisecond as the evaluation', () => {
		const result = computeEngagementScore({ activities: [], tenureStartedAt: NOW, now: NOW });
		expectSane(result.score);
		expect(result.inputs.tenureDays).toBe(0);
	});

	it('handles a tenure start in the FUTURE without amplifying the prior', () => {
		const future = computeEngagementScore({
			activities: [],
			tenureStartedAt: NOW + 90 * DAY,
			now: NOW,
		});
		const same = computeEngagementScore({ activities: [], tenureStartedAt: NOW, now: NOW });
		expectSane(future.score);
		expect(future.score).toBe(same.score);
		expect(future.inputs.tenureDays).toBe(0);
	});
});

describe('clock skew', () => {
	it('clamps a future-dated activity to `now` instead of over-weighting it', () => {
		const future = computeEngagementScore({
			activities: [{ kind: 'click', occurredAt: NOW + 365 * DAY }],
			tenureStartedAt: NOW - 300 * DAY,
			now: NOW,
		});
		const present = computeEngagementScore({
			activities: [{ kind: 'click', occurredAt: NOW }],
			tenureStartedAt: NOW - 300 * DAY,
			now: NOW,
		});
		expectSane(future.score);
		expect(future.score).toBe(present.score);
	});

	it('treats a backwards `now` as a no-op decay, never an amplification', () => {
		const state: EngagementScoreState = { raw: 30, softBounceRaw: 1, isSuppressed: false };
		const backwards = decayState(state, NOW, NOW - 90 * DAY);
		expect(backwards.raw).toBe(30);
		expect(backwards.softBounceRaw).toBe(1);
	});

	it('never returns above 100 for an absurd burst of activity', () => {
		const activities: EngagementActivity[] = Array.from({ length: 5000 }, (_, i) => ({
			kind: 'click',
			occurredAt: NOW - i,
		}));
		const result = computeEngagementScore({
			activities,
			tenureStartedAt: NOW - 10 * DAY,
			now: NOW,
		});
		expectSane(result.score);
		expect(result.score).toBe(100);
	});
});

describe('duplicates', () => {
	it('collapses exact (kind, occurredAt) duplicates — a double-write is one event', () => {
		const once = computeEngagementScore({
			activities: [{ kind: 'open', occurredAt: NOW - DAY }],
			tenureStartedAt: NOW - 300 * DAY,
			now: NOW,
		});
		const thrice = computeEngagementScore({
			activities: [
				{ kind: 'open', occurredAt: NOW - DAY },
				{ kind: 'open', occurredAt: NOW - DAY },
				{ kind: 'open', occurredAt: NOW - DAY },
			],
			tenureStartedAt: NOW - 300 * DAY,
			now: NOW,
		});
		expect(thrice.score).toBe(once.score);
		expect(thrice.inputs.openCount).toBe(1);
		expect(thrice.inputs.discardedCount).toBe(2);
	});

	it('keeps two genuinely distinct opens a millisecond apart', () => {
		const result = computeEngagementScore({
			activities: [
				{ kind: 'open', occurredAt: NOW - DAY },
				{ kind: 'open', occurredAt: NOW - DAY + 1 },
			],
			tenureStartedAt: NOW - 300 * DAY,
			now: NOW,
		});
		expect(result.inputs.openCount).toBe(2);
		expect(result.inputs.discardedCount).toBe(0);
	});

	it('does not collapse different kinds sharing a timestamp', () => {
		const result = computeEngagementScore({
			activities: [
				{ kind: 'open', occurredAt: NOW - DAY },
				{ kind: 'click', occurredAt: NOW - DAY },
			],
			tenureStartedAt: NOW - 300 * DAY,
			now: NOW,
		});
		expect(result.inputs.openCount).toBe(1);
		expect(result.inputs.clickCount).toBe(1);
		expect(result.inputs.discardedCount).toBe(0);
	});
});

describe('NaN / negative guards', () => {
	it('discards activities with a non-finite timestamp', () => {
		const result = computeEngagementScore({
			activities: [
				{ kind: 'open', occurredAt: Number.NaN },
				{ kind: 'click', occurredAt: Number.POSITIVE_INFINITY },
				{ kind: 'open', occurredAt: Number.NEGATIVE_INFINITY },
				{ kind: 'open', occurredAt: NOW - 2 * DAY },
			],
			tenureStartedAt: NOW - 300 * DAY,
			now: NOW,
		});
		expectSane(result.score);
		expect(result.inputs.discardedCount).toBe(3);
		expect(result.inputs.openCount).toBe(1);
	});

	it('survives a NaN `now`', () => {
		const result = computeEngagementScore({
			activities: [{ kind: 'open', occurredAt: NOW - DAY }],
			tenureStartedAt: NOW - 300 * DAY,
			now: Number.NaN,
		});
		expectSane(result.score);
	});

	it('survives a corrupt cached accumulator (NaN / negative / non-boolean)', () => {
		const corrupt = [
			{ raw: Number.NaN, softBounceRaw: 0, isSuppressed: false },
			{ raw: Number.POSITIVE_INFINITY, softBounceRaw: 0, isSuppressed: false },
			{ raw: -500, softBounceRaw: -3, isSuppressed: false },
			{ raw: 12, softBounceRaw: Number.NaN, isSuppressed: false },
		] satisfies EngagementScoreState[];

		for (const state of corrupt) {
			const projected = scoreFromState({
				state,
				stateAt: NOW - 10 * DAY,
				tenureStartedAt: NOW - 300 * DAY,
				now: NOW,
			});
			expectSane(projected.score);
			expect(projected.state.raw).toBeGreaterThanOrEqual(0);
			expect(projected.state.softBounceRaw).toBeGreaterThanOrEqual(0);
		}
	});

	it('never mutates the shared empty state', () => {
		const before = { ...EMPTY_ENGAGEMENT_STATE };
		computeEngagementScore({
			activities: [{ kind: 'click', occurredAt: NOW }],
			tenureStartedAt: NOW,
			now: NOW,
		});
		expect(EMPTY_ENGAGEMENT_STATE).toEqual(before);
	});
});

describe('bounded work', () => {
	it('scores a 10k-activity contact without unbounded allocation', () => {
		const activities: EngagementActivity[] = Array.from({ length: 10_000 }, (_, i) => ({
			kind: i % 7 === 0 ? 'click' : 'open',
			occurredAt: NOW - i * 60_000,
		}));

		const started = Date.now();
		const result = computeEngagementScore({
			activities,
			tenureStartedAt: NOW - 900 * DAY,
			now: NOW,
		});
		const elapsed = Date.now() - started;

		expectSane(result.score);
		// Allocation is O(n) in the caller-supplied list and nothing else — one
		// array + one Set. Wall time is a coarse smoke check against an
		// accidental O(n^2) (a nested scan over the timeline).
		expect(elapsed).toBeLessThan(2000);
		expect(result.inputs.openCount + result.inputs.clickCount).toBe(10_000);
	});
});

describe('percentile guards', () => {
	it('stays in [0, 1] for hostile inputs', () => {
		for (const score of [Number.NaN, -1e9, 1e9, 0]) {
			const p = engagementPercentile([0, 1, 2, 3], score);
			expect(p).toBeGreaterThanOrEqual(0);
			expect(p).toBeLessThanOrEqual(1);
		}
	});

	it('bands a non-finite score as cold rather than throwing', () => {
		expect(engagementBand(Number.NaN)).toBe('cold');
	});
});
