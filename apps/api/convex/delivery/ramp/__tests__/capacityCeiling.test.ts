/**
 * THE CEILING ARITHMETIC: remaining headroom / projected demand x SAFETY.
 *
 * SAFETY (0.8) is the 20% the plan keeps back for transactional bursts, so it is
 * asserted as a NUMBER here rather than paraphrased — a silent change to it is a
 * silent change to how much of the warming cap a campaign is allowed to fill.
 *
 * The ceiling is one of THREE bounds the ladder mins together (`OWN_SHARE_CEILING`,
 * the capacity bound and the PHASE ceiling), and which of them binds is what the
 * decision's reason names. That composition is asserted through `nextShare`, not
 * re-implemented here.
 */

import { describe, expect, it } from 'vitest';
import { OWN_SHARE_CEILING } from '@owlat/shared/deliverabilityRouting';
import { capacityCeiling } from '../controllerBounds';
import { RAMP_AIMD, RAMP_PHASE_CEILINGS } from '../controllerConfig';
import { nextShare } from '../controller';
import { remainingDemandToday } from '../capacityProjection';
import { controllerInput, mixState, NOW } from './controllerFixtures';

function ceiling(warmingCapRemaining: number, projectedVolume: number): number | null {
	return capacityCeiling({ kind: 'projected', warmingCapRemaining, projectedVolume });
}

describe('capacityCeiling arithmetic', () => {
	it('applies the 0.8 safety factor to headroom over demand', () => {
		expect(RAMP_AIMD.capacitySafety).toBe(0.8);
		expect(ceiling(800, 1000) ?? 0).toBeCloseTo(0.64, 10);
		expect(ceiling(500, 1000) ?? 0).toBeCloseTo(0.4, 10);
	});

	it('never promises more than the whole cell, however much headroom there is', () => {
		expect(ceiling(1_000_000, 10)).toBe(OWN_SHARE_CEILING);
		// Even at exactly the safety boundary the clamp is what answers.
		expect(ceiling(1250, 1000)).toBe(OWN_SHARE_CEILING);
	});

	it('a SPENT cap projects a zero ceiling — a bound, not a breach', () => {
		expect(ceiling(0, 1000)).toBe(0);
	});

	it('clamps into [0, 1] and refuses unusable numbers rather than guessing', () => {
		expect(ceiling(-100, 1000)).toBeNull();
		expect(ceiling(800, -1)).toBeNull();
		expect(ceiling(Number.NaN, 1000)).toBeNull();
		expect(ceiling(800, Number.NaN)).toBeNull();
		expect(ceiling(Number.POSITIVE_INFINITY, 1000)).toBeNull();
	});
});

describe('remainingDemandToday scales demand to the day that is left', () => {
	it('scales a whole-day projection by the remaining fraction of the UTC day', () => {
		// NOW is 08:00 UTC: two thirds of the day still ahead.
		expect(remainingDemandToday(3000, NOW) ?? 0).toBeCloseTo(2000, 6);
	});

	it('is what stops the ceiling sawtoothing: cap and demand decay together', () => {
		const morning = remainingDemandToday(3000, NOW) ?? 0;
		const evening = remainingDemandToday(3000, NOW + 8 * 60 * 60 * 1000) ?? 0;
		expect(evening).toBeLessThan(morning);
		// A cap that has been spent in proportion holds the SAME ceiling.
		expect(ceiling(600, morning) ?? 0).toBeCloseTo(ceiling(300, evening) ?? 0, 10);
	});
});

describe('which bound binds, through the ladder', () => {
	/**
	 * The two capacity numbers go in EXPLICITLY and the bound they derive comes
	 * back out, so a fixture can never quietly change which of the two ceilings
	 * binds: an earlier version of this suite hid the capacity bound behind
	 * arithmetic that happened to land on the phase ceiling, and the branch it
	 * claimed to cover was never separated from the one beside it.
	 *
	 * `phaseCeiling` must be a REAL ladder rung (`RAMP_PHASE_CEILINGS`) —
	 * `normalizePhaseCeiling` snaps anything else onto the lowest rung, which is
	 * the second half of how that fixture went wrong.
	 */
	function decide(args: {
		share: number;
		phaseCeiling: number;
		warmingCapRemaining: number;
		projectedVolume: number;
	}) {
		const capacity = {
			kind: 'projected',
			warmingCapRemaining: args.warmingCapRemaining,
			projectedVolume: args.projectedVolume,
		} as const;
		return {
			capacityBound: capacityCeiling(capacity),
			decision: nextShare(
				controllerInput({
					mix: mixState({
						share: args.share,
						phaseCeiling: args.phaseCeiling,
						cleanStreak: 3,
						lastCountedAt: NOW - 2 * 86_400_000,
					}),
					capacity,
				})
			),
		};
	}

	it('every phase ceiling this suite uses is a real rung', () => {
		// Guards the exact defect above: an off-ladder value normalises onto the
		// lowest rung, so the fixture would stop testing what it says it tests.
		for (const rung of [0.25, 1] as const) {
			expect(RAMP_PHASE_CEILINGS).toContain(rung);
		}
	});

	it('THE PHASE CEILING BINDS FIRST when it is the lower of the two', () => {
		// (500 / 800) x 0.8 = 0.5 of capacity, against a phase rung of 0.25.
		const { capacityBound, decision } = decide({
			share: 0.9,
			phaseCeiling: 0.25,
			warmingCapRemaining: 500,
			projectedVolume: 800,
		});
		expect(capacityBound ?? 0).toBeCloseTo(0.5, 10);
		expect(decision.share).toBe(0.25);
		expect(decision.reason).toBe('phase_ceiling');
		expect(decision.ceiling).toBe(0.25);
	});

	it('the CAPACITY bound binds when it is the lower of the two, and says so', () => {
		const { capacityBound, decision } = decide({
			share: 0.9,
			phaseCeiling: 1,
			warmingCapRemaining: 500,
			projectedVolume: 800,
		});
		expect(capacityBound ?? 0).toBeCloseTo(0.5, 10);
		expect(decision.ceiling ?? 0).toBeCloseTo(0.5, 10);
		expect(decision.share).toBeCloseTo(0.5, 10);
		expect(decision.reason).toBe('capacity_ceiling');
	});

	it('a capacity bound ABOVE the current share never becomes an instant jump', () => {
		// Retreats are instant; advances cost a counted window and one step.
		const { capacityBound, decision } = decide({
			share: 0.2,
			phaseCeiling: 1,
			warmingCapRemaining: 900,
			projectedVolume: 800,
		});
		expect(capacityBound ?? 0).toBeCloseTo(0.9, 10);
		expect(decision.share).toBeLessThanOrEqual(0.26);
		expect(decision.share).toBeGreaterThan(0.2);
	});

	it('a bound a hair above the share is a HOLD that names the bound, not a healthy increase', () => {
		// 251 sends of headroom against a projected 2007 gives 0.100049…, which is
		// above 0.1 and rounds back onto it at the stored four-decimal precision.
		// The increase rung compares against the ROUNDED share, so an unrounded
		// bound would clear the comparison, report `healthy` — an increase — and
		// then store the number the cell already had: a decision the audit row and
		// the operator's sentence both describe as a move that never happened. The
		// graduation rung defends its pin target the same way.
		const { capacityBound, decision } = decide({
			share: 0.1,
			phaseCeiling: 1,
			warmingCapRemaining: 251,
			projectedVolume: 2007,
		});
		expect(capacityBound ?? 0).toBeGreaterThan(0.1);
		expect(capacityBound ?? 0).toBeLessThan(0.1001);
		expect(decision.share).toBe(0.1);
		expect(decision.direction).toBe('hold');
		expect(decision.reason).toBe('capacity_ceiling');
	});
});
