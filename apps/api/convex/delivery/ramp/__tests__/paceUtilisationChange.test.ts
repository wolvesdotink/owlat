/**
 * THE ONE SANCTIONED BEHAVIOUR CHANGE, FIXTURE-PINNED (plan D19, P3-7).
 *
 * EVERY other divergence from shipped behaviour in this plan is a defect. This
 * one is deliberate, and it is called out in the PR body that ships it.
 *
 * BEFORE — the shipped MTA evaluator (`applyWarmingScheduleAdjustment`): the
 * acceleration branch requires `usageRate >= ADAPTIVE_WARMING_POLICY
 * .acceleration.usageRateMinimum` (0.8). A deployment sending less than its cap
 * therefore never qualifies, falls through to the `else`, and ADVANCES THE
 * SCHEDULE ONE DAY ANYWAY — growing a cap that nothing is exercising.
 *
 * AFTER — the pace actuator: the same reading is INSUFFICIENT EVIDENCE and the
 * dial HOLDS. An unexercised cap is not evidence that a bigger one is safe. It
 * is not a penalty either: nothing retreats, the day is left UNCOUNTED so a
 * later tick can still evaluate it once the volume arrives, and a breach still
 * retreats at full speed because every retreat rung sits above this one.
 *
 * The BEFORE is asserted in this same file, against the same numbers, so the
 * change is visible as a change rather than as an assertion nobody can date.
 */

import { describe, expect, it } from 'vitest';
import { ADAPTIVE_WARMING_POLICY } from '@owlat/shared/warming';
import { isCapExercised, nextPaceMultiplier, PACE_MINIMUM_UTILISATION } from '../paceActuator';
import {
	breachedEvaluation,
	EXERCISED,
	NOW,
	paceInput,
	paceState,
	UNEXERCISED,
} from './controllerFixtures';
import { utcDayKey } from '../../../lib/utcDay';

/**
 * THE SHIPPED PREDICATE, transcribed from `applyWarmingScheduleAdjustment`'s
 * acceleration branch. It is here so the "before" is a statement about the
 * shipped rule rather than a memory of it — and so a future change to
 * `usageRateMinimum` fails this suite instead of drifting past it.
 */
function shippedAdvancesSchedule(usageRate: number): 'accelerated' | 'advanced_one_day' {
	return usageRate >= ADAPTIVE_WARMING_POLICY.acceleration.usageRateMinimum
		? 'accelerated'
		: 'advanced_one_day';
}

const UNEXERCISED_USAGE_RATE =
	UNEXERCISED.kind === 'measured' ? UNEXERCISED.sent / UNEXERCISED.enforcedCap : 0;

describe('the utilisation rule — BEFORE (shipped)', () => {
	it('the shipped evaluator advances the schedule anyway on a cap nobody filled', () => {
		expect(UNEXERCISED_USAGE_RATE).toBeLessThan(
			ADAPTIVE_WARMING_POLICY.acceleration.usageRateMinimum
		);
		// It does not accelerate — but it does not hold either. It advances one day,
		// growing a cap the deployment has given no evidence it can carry.
		expect(shippedAdvancesSchedule(UNEXERCISED_USAGE_RATE)).toBe('advanced_one_day');
	});

	it('the threshold the pace actuator adopts is the shipped number, unchanged', () => {
		expect(PACE_MINIMUM_UTILISATION).toBe(ADAPTIVE_WARMING_POLICY.acceleration.usageRateMinimum);
	});
});

describe('the utilisation rule — AFTER (pace actuator)', () => {
	it('HOLDS on a cap nobody exercised, where the shipped evaluator advanced', () => {
		const decision = nextPaceMultiplier(paceInput({ utilisation: UNEXERCISED }));
		expect(decision.direction).toBe('hold');
		expect(decision.reason).toBe('low_utilisation');
		expect(decision.multiplier).toBe(1);
	});

	it('leaves the day UNCOUNTED, so a later tick can still evaluate it', () => {
		const held = nextPaceMultiplier(paceInput({ utilisation: UNEXERCISED }));
		expect(held.countedUtcDay).toBeUndefined();
		// Volume arrives later the same day; the day is still available to count.
		const advanced = nextPaceMultiplier(
			paceInput({
				pace: paceState({ lastEvaluatedUtcDay: held.countedUtcDay }),
				utilisation: EXERCISED,
			})
		);
		expect(advanced.direction).toBe('increase');
		expect(advanced.countedUtcDay).toBe(utcDayKey(NOW));
	});

	it('is a HOLD, not a penalty: nothing retreats and nothing freezes', () => {
		const decision = nextPaceMultiplier(paceInput({ utilisation: UNEXERCISED }));
		expect(decision.direction).not.toBe('decrease');
		expect(decision.freeze).toBeUndefined();
	});

	it('still retreats at full speed on a breach, however little was sent', () => {
		const decision = nextPaceMultiplier(
			paceInput({ utilisation: UNEXERCISED, evaluation: breachedEvaluation('complaint') })
		);
		expect(decision.direction).toBe('decrease');
		expect(decision.multiplier).toBeCloseTo(0.5, 5);
	});

	it('an UNKNOWN utilisation reading holds too — absence is never evidence', () => {
		const decision = nextPaceMultiplier(paceInput({ utilisation: { kind: 'unknown' } }));
		expect(decision.reason).toBe('low_utilisation');
		expect(decision.direction).toBe('hold');
	});
});

describe('isCapExercised — degenerate readings never buy a step', () => {
	it('refuses a zero, negative or non-finite cap rather than dividing by it', () => {
		for (const enforcedCap of [0, -100, Number.NaN, Infinity]) {
			expect(isCapExercised({ kind: 'measured', sent: 10_000, enforcedCap })).toBe(false);
		}
	});

	it('refuses a non-finite or non-positive send count', () => {
		for (const sent of [0, -5, Number.NaN]) {
			expect(isCapExercised({ kind: 'measured', sent, enforcedCap: 100 })).toBe(false);
		}
	});

	it('accepts a genuinely exercised cap', () => {
		expect(isCapExercised(EXERCISED)).toBe(true);
	});
});
