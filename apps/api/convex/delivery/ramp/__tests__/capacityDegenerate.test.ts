/**
 * THE DEGENERATE HALF, which is the interesting half.
 *
 * A projection can fail to exist in a dozen ordinary ways — a cell that has never
 * sent, a paused campaign, a clock that came back unusable, the last minutes of a
 * UTC day where both sides of the ratio are collapsing. Every one of them must
 * produce the SAME thing: a HOLD.
 *
 * The two failures this file exists to make impossible:
 *   · an UNKNOWN projection read as "no limit", which would ramp hardest exactly
 *     where the controller understands least;
 *   · a ZERO projection read as a denominator, which is the division-by-zero bug
 *     dressed as a business rule (`headroom / 0` is `Infinity`, clamped to a full
 *     share — a cell with no measured demand handed the whole cap).
 */

import { describe, expect, it } from 'vitest';
import { OWN_SHARE_CEILING } from '@owlat/shared/deliverabilityRouting';
import { capacityCeiling } from '../controllerBounds';
import { nextShare } from '../controller';
import {
	CAPACITY_MIN_DAY_FRACTION_REMAINING,
	projectCellVolume,
	remainingDemandToday,
	rerouteMissRate,
	type CellVolumeDay,
} from '../capacityProjection';
import { controllerInput, mixState, DAY, NOW } from './controllerFixtures';

const TODAY = NOW - (NOW % DAY);

function day(offset: number, total: number, own = total): CellVolumeDay {
	return { dayStartMs: TODAY - offset * DAY, total, own };
}

describe('a projection that cannot be made is UNKNOWN, never zero and never infinite', () => {
	it('zero volume across the window is unknown, not a zero denominator', () => {
		expect(projectCellVolume([day(1, 0), day(2, 0), day(3, 0)], NOW)).toEqual({
			kind: 'unknown',
			reason: 'no_volume',
		});
	});

	it('a mostly-idle week whose MEDIAN day is zero is unknown too', () => {
		// Four zero days out of seven: the statistic is 0, and a zero that reached
		// the ceiling would divide by it.
		const days = [
			day(1, 0),
			day(2, 0),
			day(3, 500),
			day(4, 0),
			day(5, 0),
			day(6, 400),
			day(7, 300),
		];
		expect(projectCellVolume(days, NOW)).toEqual({ kind: 'unknown', reason: 'no_volume' });
	});

	it('poisoned counters contribute nothing rather than poisoning the projection', () => {
		const days = [
			day(1, Number.NaN),
			day(2, Number.POSITIVE_INFINITY),
			day(3, -5000),
			day(4, 1000),
			day(5, 1000),
			day(6, 1000),
		];
		expect(projectCellVolume(days, NOW)).toMatchObject({ kind: 'projected' });
		const projection = projectCellVolume(days, NOW);
		if (projection.kind !== 'projected') throw new Error('expected a projection');
		expect(Number.isFinite(projection.dailyVolume)).toBe(true);
		expect(projection.dailyVolume).toBeGreaterThan(0);
	});

	it('an unusable clock is unknown rather than a window anchored at the epoch', () => {
		expect(projectCellVolume([day(1, 1000)], Number.NaN)).toEqual({
			kind: 'unknown',
			reason: 'clock_unusable',
		});
	});

	it('a day stamped with an unusable instant is dropped, not counted', () => {
		expect(projectCellVolume([{ dayStartMs: Number.NaN, total: 9_999, own: 9_999 }], NOW)).toEqual({
			kind: 'unknown',
			reason: 'no_history',
		});
	});
});

describe('the end of a UTC day holds rather than deciding', () => {
	it('refuses the reading once too little of the day is left to measure', () => {
		const nearlyMidnight = TODAY + DAY - Math.floor(CAPACITY_MIN_DAY_FRACTION_REMAINING * DAY) + 1;
		expect(remainingDemandToday(1000, nearlyMidnight)).toBeNull();
	});

	it('still answers with the guard fraction exactly remaining', () => {
		const boundary = TODAY + DAY - CAPACITY_MIN_DAY_FRACTION_REMAINING * DAY;
		const demand = remainingDemandToday(1000, boundary);
		expect(demand).not.toBeNull();
		expect(demand ?? 0).toBeCloseTo(1000 * CAPACITY_MIN_DAY_FRACTION_REMAINING, 6);
	});

	it('refuses a zero or unusable daily volume rather than returning zero demand', () => {
		expect(remainingDemandToday(0, NOW)).toBeNull();
		expect(remainingDemandToday(Number.NaN, NOW)).toBeNull();
		expect(remainingDemandToday(1000, Number.NaN)).toBeNull();
	});
});

describe('an unknown capacity reading HOLDS the controller', () => {
	it('capacityCeiling returns null — not a ceiling of one, not a ceiling of zero', () => {
		expect(capacityCeiling({ kind: 'unknown', reason: 'demand_unprojectable' })).toBeNull();
	});

	it('the ladder holds the share exactly where it was and says why', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.4, cleanStreak: 3, lastCountedAt: NOW - 2 * DAY }),
				capacity: { kind: 'unknown', reason: 'demand_unprojectable' },
			})
		);
		expect(decision.share).toBe(0.4);
		expect(decision.reason).toBe('capacity_unknown');
		expect(decision.direction).toBe('hold');
	});

	it('and it does not RETREAT either — thin data moves nothing (plan D10)', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.8, cleanStreak: 3, lastCountedAt: NOW - 2 * DAY }),
				capacity: { kind: 'unknown', reason: 'demand_unprojectable' },
			})
		);
		expect(decision.share).toBe(0.8);
	});

	it('a MISSING warming reading is the other case: it constrains nothing (plan D2)', () => {
		expect(capacityCeiling({ kind: 'unconstrained' })).toBe(OWN_SHARE_CEILING);
	});
});

describe('a ZERO projected volume holds as well — the division is never reached', () => {
	/** A real cap over a demand of nothing: the shape the card singles out. */
	const zeroDenominator = {
		kind: 'projected',
		warmingCapRemaining: 4_000,
		projectedVolume: 0,
	} as const;

	it('answers null rather than dividing a real cap by nothing', () => {
		expect(capacityCeiling(zeroDenominator)).toBeNull();
	});

	it('is NEITHER of the two wrong answers — not a full share, not a zero one', () => {
		// `4000 / 0` is `Infinity`, which clamps to a FULL share: the cell we
		// measured least would be handed the whole cap. The opposite reading — a
		// ceiling of zero — would retreat a cell for the crime of being quiet.
		// Both are ruled out by the same assertion.
		const ceiling = capacityCeiling(zeroDenominator);
		expect(ceiling).not.toBe(OWN_SHARE_CEILING);
		expect(ceiling).not.toBe(0);
	});

	it('a zero cap over a zero demand is the same non-answer, not a spent cap', () => {
		expect(
			capacityCeiling({ kind: 'projected', warmingCapRemaining: 0, projectedVolume: 0 })
		).toBeNull();
	});

	it('and the ladder holds the share exactly where it was', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.4, cleanStreak: 3, lastCountedAt: NOW - 2 * DAY }),
				capacity: zeroDenominator,
			})
		);
		expect(decision.share).toBe(0.4);
		expect(decision.direction).toBe('hold');
		expect(decision.reason).toBe('capacity_unknown');
	});
});

describe('rerouteMissRate refuses meaningless questions', () => {
	it('is null when there is no projection to measure against', () => {
		expect(rerouteMissRate({ kind: 'unknown', reason: 'no_volume' }, 0.5)).toBeNull();
	});

	it('is null when the cell was assigned no own traffic at all — nothing to miss', () => {
		const projection = projectCellVolume([day(1, 1000, 0), day(2, 1000, 0)], NOW);
		expect(rerouteMissRate(projection, 0)).toBeNull();
		expect(rerouteMissRate(projection, Number.NaN)).toBeNull();
	});

	it('is zero, never negative, when the own arm carried MORE than its share', () => {
		const projection = projectCellVolume([day(1, 1000, 900), day(2, 1000, 900)], NOW);
		expect(rerouteMissRate(projection, 0.5)).toBe(0);
	});
});
