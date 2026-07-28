/**
 * THE PER-UTC-DAY IDEMPOTENCY GUARD, PRESERVED (plan D19, P3-7).
 *
 * The shipped MTA warming evaluator advances a schedule AT MOST ONCE per UTC
 * day, because the cron calls it hourly and a clean IP would otherwise walk the
 * entire published ramp in about thirty HOURS. The pace actuator ticks on the
 * same hourly cron against the same daily evidence, so it inherits the same
 * guard — and this is the suite that proves it, because it is exactly the
 * single-line mistake that would let an hourly controller advance a warming
 * schedule twenty-four times a day.
 */

import { describe, expect, it } from 'vitest';
import { nextPaceMultiplier } from '../paceActuator';
import { PACE_AIMD } from '../paceConfig';
import { utcDayKey } from '../../../lib/utcDay';
import { cleanEvaluation, EXERCISED, NOW, paceInput, paceState } from './controllerFixtures';
import type { PaceState } from '../paceTypes';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DAY_START = Math.floor(NOW / DAY) * DAY;

/**
 * The cron shell, in four lines: load, call, write back. The real one
 * (`rampControllerCron`) does the same thing against the route-state row; here
 * it exists so the suite can tick a clock the way production does.
 */
function tick(state: PaceState, now: number): { state: PaceState; direction: string } {
	const decision = nextPaceMultiplier(
		paceInput({
			pace: state,
			// Fresh evidence on every tick: a controller starved of evidence would
			// hold for a reason this suite is not testing.
			evaluation: cleanEvaluation(3, now),
			utilisation: EXERCISED,
			now,
		})
	);
	return {
		state: {
			...state,
			multiplier: decision.multiplier,
			cleanStreak: decision.cleanStreak,
			lastEvaluatedUtcDay: decision.countedUtcDay ?? state.lastEvaluatedUtcDay,
		},
		direction: decision.direction,
	};
}

describe('pace actuator — the per-UTC-day idempotency guard', () => {
	it('advances the schedule exactly ONCE across 24 hourly ticks in one UTC day', () => {
		let state = paceState();
		let increases = 0;
		for (let hour = 0; hour < 24; hour += 1) {
			const result = tick(state, DAY_START + hour * HOUR);
			state = result.state;
			if (result.direction === 'increase') increases += 1;
		}
		expect(increases).toBe(1);
		expect(state.multiplier).toBeCloseTo(1 + PACE_AIMD.increaseStep, 5);
		expect(state.lastEvaluatedUtcDay).toBe(utcDayKey(DAY_START));
	});

	it('advances once more the next UTC day — the guard delays, it does not stop', () => {
		let state = paceState();
		let increases = 0;
		for (let hour = 0; hour < 48; hour += 1) {
			const result = tick(state, DAY_START + hour * HOUR);
			state = result.state;
			if (result.direction === 'increase') increases += 1;
		}
		expect(increases).toBe(2);
		expect(state.multiplier).toBeCloseTo(1 + 2 * PACE_AIMD.increaseStep, 5);
	});

	it('names the guard as the reason on every subsequent tick of the same day', () => {
		const today = utcDayKey(NOW);
		const decision = nextPaceMultiplier(
			paceInput({ pace: paceState({ lastEvaluatedUtcDay: today }) })
		);
		expect(decision.direction).toBe('hold');
		expect(decision.reason).toBe('day_already_advanced');
		// And it does not re-stamp the anchor, so nothing about the day changes.
		expect(decision.countedUtcDay).toBeUndefined();
	});

	it('a stored anchor for a DIFFERENT day does not block today', () => {
		const decision = nextPaceMultiplier(
			paceInput({ pace: paceState({ lastEvaluatedUtcDay: utcDayKey(NOW - DAY) }) })
		);
		expect(decision.direction).toBe('increase');
		expect(decision.countedUtcDay).toBe(utcDayKey(NOW));
	});

	it('an empty stored anchor is never mistaken for today', () => {
		const decision = nextPaceMultiplier(
			paceInput({ pace: paceState({ lastEvaluatedUtcDay: '' }) })
		);
		expect(decision.direction).toBe('increase');
	});
});
