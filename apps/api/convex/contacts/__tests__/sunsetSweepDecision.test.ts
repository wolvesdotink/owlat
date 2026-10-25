/**
 * The sunset sweep's pure decisions (`contacts/sunsetSweepDecision.ts`), for
 * fixed snapshots and a fixed `now`. The live mutation is held to them by
 * `sunsetSweep.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
	EMPTY_TALLY,
	SUNSET_BATCH_SIZE,
	SUNSET_MAX_BATCHES,
	SUNSET_MAX_SUPPRESSIONS_PER_TICK,
	SUNSET_STALL_REPORT_INTERVAL_MS,
	canSuppressMore,
	decideClockStateWrite,
	decideSweepEnd,
	stallSummaryDetails,
	sweepBounds,
	tallyContact,
	wasStallReported,
	type SweepBounds,
	type SweepTally,
} from '../sunsetSweepDecision';

const NOW = 1_800_000_000_000;

const bounds = (overrides: Partial<SweepBounds> = {}): SweepBounds => ({
	batchSize: 10,
	batchesRemaining: 5,
	suppressedSoFar: 0,
	maxSuppressions: 100,
	...overrides,
});

const tally = (overrides: Partial<SweepTally> = {}): SweepTally => ({
	...EMPTY_TALLY,
	...overrides,
});

describe('sweepBounds', () => {
	it('takes the true defaults when the cron passes nothing', () => {
		expect(sweepBounds({})).toEqual({
			batchSize: SUNSET_BATCH_SIZE,
			batchesRemaining: SUNSET_MAX_BATCHES,
			suppressedSoFar: 0,
			maxSuppressions: SUNSET_MAX_SUPPRESSIONS_PER_TICK,
		});
	});

	it('reads an unreadable prior suppression count as the budget spent', () => {
		const read = sweepBounds({ batchSize: NaN, batchesRemaining: Infinity, suppressedSoFar: NaN });
		expect(read).toEqual({
			batchSize: SUNSET_BATCH_SIZE,
			batchesRemaining: SUNSET_MAX_BATCHES,
			suppressedSoFar: SUNSET_MAX_SUPPRESSIONS_PER_TICK,
			maxSuppressions: SUNSET_MAX_SUPPRESSIONS_PER_TICK,
		});
	});

	it('lets a caller lower the bounds but never raise them', () => {
		expect(sweepBounds({ batchSize: 3, maxSuppressions: 2 })).toMatchObject({
			batchSize: 3,
			maxSuppressions: 2,
		});
		expect(
			sweepBounds({ batchSize: 10_000, batchesRemaining: 99, maxSuppressions: 10_000 })
		).toMatchObject({
			batchSize: SUNSET_BATCH_SIZE,
			batchesRemaining: SUNSET_MAX_BATCHES,
			maxSuppressions: SUNSET_MAX_SUPPRESSIONS_PER_TICK,
		});
		expect(sweepBounds({ batchSize: 0, batchesRemaining: -4 })).toMatchObject({
			batchSize: 1,
			batchesRemaining: 0,
		});
	});
});

describe('decideClockStateWrite', () => {
	it('creates the deployment-wide row with a heartbeat on a healthy first tick', () => {
		expect(decideClockStateWrite(undefined, NOW, false)).toEqual({
			kind: 'insert',
			row: { lastSweepAt: NOW, createdAt: NOW, updatedAt: NOW },
		});
	});

	it('stamps a stall once and leaves the heartbeat where it was', () => {
		expect(decideClockStateWrite({}, NOW, true)).toEqual({
			kind: 'patch',
			patch: { clockStalledAt: NOW, updatedAt: NOW },
		});
		expect(decideClockStateWrite({ clockStalledAt: NOW - 1 }, NOW, true)).toEqual({
			kind: 'none',
		});
	});

	it('advances the heartbeat and clears a recorded stall on recovery', () => {
		const recovered = decideClockStateWrite({ clockStalledAt: NOW - 1 }, NOW, false);
		expect(recovered).toEqual({
			kind: 'patch',
			patch: { lastSweepAt: NOW, clockStalledAt: undefined, updatedAt: NOW },
		});
		expect(recovered.kind === 'patch' && 'clockStalledAt' in recovered.patch).toBe(true);
		const healthy = decideClockStateWrite({ clockStalledAt: null }, NOW, false);
		expect(healthy.kind === 'patch' && 'clockStalledAt' in healthy.patch).toBe(false);
	});
});

describe('wasStallReported', () => {
	const stall = (createdAt: number) => ({ createdAt, details: { isClockSkewed: true } });

	it('reports again only once the interval has passed', () => {
		expect(wasStallReported(null, NOW)).toBe(false);
		expect(wasStallReported(stall(NOW - 1), NOW)).toBe(true);
		expect(wasStallReported(stall(NOW - SUNSET_STALL_REPORT_INTERVAL_MS), NOW)).toBe(false);
	});

	it('does not count an ordinary summary or one stamped in the future', () => {
		expect(wasStallReported({ createdAt: NOW - 1, details: { suppressed: 3 } }, NOW)).toBe(false);
		expect(wasStallReported(stall(NOW + 1), NOW)).toBe(false);
	});

	it('names the ceiling in the stall summary', () => {
		expect(stallSummaryDetails(7)).toMatchObject({
			isClockSkewed: true,
			suppressionCeiling: 7,
			scanned: 0,
		});
	});
});

describe('tallyContact', () => {
	it('counts a soft-deleted contact as scanned and nothing else', () => {
		expect(tallyContact(EMPTY_TALLY, { kind: 'deleted' })).toEqual({
			tally: tally({ scanned: 1 }),
			restoreStamp: false,
			stop: false,
		});
	});

	it('counts each applied transition by its action, and a hold as scanned only', () => {
		const evaluated = (action: 'suppress' | 'resume' | 'enter_reengagement' | 'hold') => ({
			kind: 'evaluated' as const,
			verdict: { action },
			applied: action !== 'hold',
			deferred: false,
		});
		let current = EMPTY_TALLY;
		for (const action of ['suppress', 'resume', 'enter_reengagement', 'hold'] as const) {
			current = tallyContact(current, evaluated(action)).tally;
		}
		expect(current).toEqual(tally({ scanned: 4, suppressed: 1, resumed: 1, reengaged: 1 }));
	});

	it('restores the stamp of a refused suppression and stops the batch', () => {
		const step = tallyContact(tally({ scanned: 2, suppressed: 1 }), {
			kind: 'evaluated',
			verdict: { action: 'suppress' },
			applied: false,
			deferred: true,
		});
		expect(step).toEqual({
			tally: tally({
				scanned: 3,
				suppressed: 1,
				deferredSuppressions: 1,
				isSuppressionCeilingHit: true,
			}),
			restoreStamp: true,
			stop: true,
		});
	});

	it('allows a suppression while the tick is under its ceiling', () => {
		expect(canSuppressMore(bounds({ suppressedSoFar: 98 }), tally({ suppressed: 1 }))).toBe(true);
		expect(canSuppressMore(bounds({ suppressedSoFar: 99 }), tally({ suppressed: 1 }))).toBe(false);
	});
});

describe('decideSweepEnd', () => {
	it('finishes quietly when the stale range drained', () => {
		const end = decideSweepEnd({
			bounds: bounds(),
			tally: tally({ scanned: 3 }),
			candidateCount: 3,
			corroboratingInstant: NOW - 1000,
			now: NOW,
		});
		expect(end).toEqual({
			result: {
				scanned: 3,
				reengaged: 0,
				suppressed: 0,
				resumed: 0,
				deferredSuppressions: 0,
				isDone: true,
				isBudgetExhausted: false,
				isSuppressionCeilingHit: false,
				isClockSkewed: false,
			},
			warnings: [],
		});
	});

	it('chains the next batch with the head reading and the running suppression count', () => {
		const end = decideSweepEnd({
			bounds: bounds({ suppressedSoFar: 4 }),
			tally: tally({ scanned: 10, suppressed: 2 }),
			candidateCount: 10,
			corroboratingInstant: undefined,
			now: NOW,
		});
		expect(end.next).toEqual({
			batchesRemaining: 4,
			batchSize: 10,
			suppressedSoFar: 6,
			maxSuppressions: 100,
			corroboratingInstant: NOW,
		});
		expect(end.result.isDone).toBe(false);
		expect(end.summary).toMatchObject({ suppressed: 2, isSuppressionCeilingHit: false });
		expect(String(end.summary?.['message'])).toContain('2 contact(s) auto-suppressed');
	});

	it('warns instead of chaining on the last batch of the budget', () => {
		const end = decideSweepEnd({
			bounds: bounds({ batchesRemaining: 1 }),
			tally: tally({ scanned: 10 }),
			candidateCount: 10,
			corroboratingInstant: NOW - 1,
			now: NOW,
		});
		expect(end.next).toBeUndefined();
		expect(end.result.isBudgetExhausted).toBe(true);
		expect(end.warnings).toHaveLength(1);
		expect(end.summary).toBeUndefined();
	});

	it('stops the chain at the ceiling and words the summary off the counts', () => {
		const end = decideSweepEnd({
			bounds: bounds({ suppressedSoFar: 99, maxSuppressions: 100 }),
			tally: tally({
				scanned: 2,
				suppressed: 1,
				deferredSuppressions: 1,
				isSuppressionCeilingHit: true,
			}),
			candidateCount: 10,
			corroboratingInstant: NOW - 1,
			now: NOW,
		});
		expect(end.next).toBeUndefined();
		expect(end.result).toMatchObject({ isDone: false, isBudgetExhausted: false });
		expect(end.warnings).toEqual([
			'[sunsetSweep] suppression ceiling of 100 reached; stopped this tick with 1 suppression(s) deferred',
		]);
		expect(String(end.summary?.['message'])).toContain('(100 used so far this sweep)');
	});

	it('is the same plan on every evaluation and leaves its inputs alone', () => {
		const input = Object.freeze({
			bounds: Object.freeze(bounds()),
			tally: Object.freeze(tally({ scanned: 10, suppressed: 1 })),
			candidateCount: 10,
			corroboratingInstant: NOW - 5,
			now: NOW,
		});
		expect(decideSweepEnd(input)).toEqual(decideSweepEnd(input));
		expect(tallyContact(input.tally, { kind: 'deleted' }).tally).not.toBe(input.tally);
		expect(input.tally.scanned).toBe(10);
	});
});
