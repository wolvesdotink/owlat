import { describe, it, expect } from 'vitest';
import {
	ENGAGEMENT_HALF_LIFE_DAYS,
	applyActivity,
	computeEngagementScore,
	decayState,
	engagementBand,
	scoreFromState,
	type EngagementActivity,
	type EngagementScoreState,
} from '../engagementScore';

/**
 * Decay properties of the engagement score (deliverability plan P0-2).
 *
 * Three invariants the controller and the MTA priority bands depend on:
 *  - MONOTONICITY: with no new activity, time only ever lowers the score.
 *  - DETERMINISM: identical inputs give a byte-identical result.
 *  - NO DAY-BOUNDARY CLIFF: decay is continuous, so nobody changes band because
 *    a UTC day rolled over. (A step-function decay would make the MTA's
 *    priority assignment jitter at midnight for the whole book at once.)
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

const TIMELINE: EngagementActivity[] = [
	{ kind: 'click', occurredAt: NOW - 4 * DAY },
	{ kind: 'open', occurredAt: NOW - 2 * DAY },
	{ kind: 'open', occurredAt: NOW - 18 * DAY },
	{ kind: 'soft_bounce', occurredAt: NOW - 40 * DAY },
];

const TENURE_STARTED_AT = NOW - 300 * DAY;

function scoreAt(now: number): number {
	return computeEngagementScore({
		activities: TIMELINE,
		tenureStartedAt: TENURE_STARTED_AT,
		now,
	}).score;
}

describe('monotonicity', () => {
	it('is non-increasing as `now` advances with no new activity', () => {
		let previous = Number.POSITIVE_INFINITY;
		for (let day = 0; day <= 365; day += 1) {
			const score = scoreAt(NOW + day * DAY);
			expect(score).toBeLessThanOrEqual(previous);
			previous = score;
		}
		expect(previous).toBeLessThan(20);
	});

	it('is non-increasing at hour granularity too (no local bumps)', () => {
		let previous = Number.POSITIVE_INFINITY;
		for (let hour = 0; hour <= 24 * 30; hour += 1) {
			const score = scoreAt(NOW + hour * HOUR);
			expect(score).toBeLessThanOrEqual(previous);
			previous = score;
		}
	});

	it('halves the accumulator over exactly one half-life', () => {
		const state: EngagementScoreState = { raw: 64, softBounceRaw: 8, suppressed: false };
		const decayed = decayState(state, NOW, NOW + ENGAGEMENT_HALF_LIFE_DAYS * DAY);
		expect(decayed.raw).toBeCloseTo(32, 9);
		expect(decayed.softBounceRaw).toBeCloseTo(4, 9);
	});

	it('never lets a suppressed contact recover through decay alone', () => {
		const suppressed: EngagementScoreState = { raw: 40, softBounceRaw: 0, suppressed: true };
		for (const days of [0, 30, 400, 5000]) {
			const projected = scoreFromState({
				state: suppressed,
				stateAt: NOW,
				tenureStartedAt: TENURE_STARTED_AT,
				now: NOW + days * DAY,
			});
			expect(projected.score).toBe(0);
			expect(projected.state.suppressed).toBe(true);
		}
	});
});

describe('determinism', () => {
	it('gives an identical result for identical inputs', () => {
		const a = computeEngagementScore({
			activities: TIMELINE,
			tenureStartedAt: TENURE_STARTED_AT,
			now: NOW,
		});
		const b = computeEngagementScore({
			activities: TIMELINE,
			tenureStartedAt: TENURE_STARTED_AT,
			now: NOW,
		});
		expect(a).toEqual(b);
	});

	it('does not depend on the order the activities arrive in', () => {
		const forward = computeEngagementScore({
			activities: TIMELINE,
			tenureStartedAt: TENURE_STARTED_AT,
			now: NOW,
		});
		const reversed = computeEngagementScore({
			activities: [...TIMELINE].reverse(),
			tenureStartedAt: TENURE_STARTED_AT,
			now: NOW,
		});
		expect(reversed.score).toBe(forward.score);
		expect(reversed.state.raw).toBeCloseTo(forward.state.raw, 9);
	});
});

describe('no UTC-day-boundary cliff', () => {
	const boundary = Date.UTC(2026, 6, 28, 0, 0, 0);

	it('moves by at most a point across midnight, and never changes band', () => {
		const singleOpen: EngagementActivity[] = [{ kind: 'open', occurredAt: NOW - 9 * DAY }];
		for (const timeline of [TIMELINE, singleOpen]) {
			const before = computeEngagementScore({
				activities: timeline,
				tenureStartedAt: TENURE_STARTED_AT,
				now: boundary - 1000,
			}).score;
			const after = computeEngagementScore({
				activities: timeline,
				tenureStartedAt: TENURE_STARTED_AT,
				now: boundary + 1000,
			}).score;
			expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
			expect(engagementBand(after)).toBe(engagementBand(before));
		}
	});

	it('holds for a brand-new contact, whose tenure prior decays fastest', () => {
		const born = boundary - 2 * DAY;
		const before = computeEngagementScore({
			activities: [],
			tenureStartedAt: born,
			now: boundary - 1000,
		}).score;
		const after = computeEngagementScore({
			activities: [],
			tenureStartedAt: born,
			now: boundary + 1000,
		}).score;
		expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
		expect(engagementBand(after)).toBe(engagementBand(before));
	});
});

describe('fold/increment equivalence', () => {
	it('matches a full recompute when the same activities are folded one at a time', () => {
		const full = computeEngagementScore({
			activities: TIMELINE,
			tenureStartedAt: TENURE_STARTED_AT,
			now: NOW,
		});

		const ordered = [...TIMELINE].sort((a, b) => a.occurredAt - b.occurredAt);
		let state: EngagementScoreState = { raw: 0, softBounceRaw: 0, suppressed: false };
		let stateAt = ordered[0]?.occurredAt ?? NOW;
		for (const activity of ordered) {
			state = applyActivity(decayState(state, stateAt, activity.occurredAt), activity.kind);
			stateAt = activity.occurredAt;
		}
		const incremental = scoreFromState({
			state,
			stateAt,
			tenureStartedAt: TENURE_STARTED_AT,
			now: NOW,
		});

		expect(incremental.score).toBe(full.score);
		expect(incremental.state.raw).toBeCloseTo(full.state.raw, 9);
		expect(incremental.state.softBounceRaw).toBeCloseTo(full.state.softBounceRaw, 9);
	});
});
