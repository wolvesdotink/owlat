/**
 * THE COMPOSITION ORDER (plan D3, P3-7).
 *
 * When both actuators exist they compose in a FIXED order — share first (cheap,
 * instantly reversible, the relay absorbs the difference), pace second (slow,
 * reputation-bearing) — and A CELL MAY NEVER INCREASE BOTH IN THE SAME WINDOW.
 * Two reputation-bearing dials moving together produce a result nobody can read.
 *
 * This is one of the two single-line mistakes this piece is reviewed for, so the
 * suite asserts the interlock in both directions AND asserts what it must NOT
 * do: it may never move the share, never freeze the pace dial it held back, and
 * never ration a retreat.
 */

import { describe, expect, it } from 'vitest';
import { composeActuators } from '../actuatorComposition';
import type { ComposedActuators } from '../actuatorComposition';
import { nextShare } from '../controller';
import { RAMP_AIMD } from '../controllerConfig';
import { nextPaceMultiplier } from '../paceActuator';
import { PACE_AIMD, PACE_INITIAL_MULTIPLIER } from '../paceConfig';
import type { PaceState } from '../paceTypes';
import {
	breachedEvaluation,
	cleanEvaluation,
	controllerInput,
	HOUR,
	mixState,
	NOW,
	paceInput,
	paceState,
	thinEvaluation,
} from './controllerFixtures';

const increasingShare = () => nextShare(controllerInput());
const holdingShare = () => nextShare(controllerInput({ evaluation: thinEvaluation(3) }));
const decreasingShare = () =>
	nextShare(controllerInput({ evaluation: breachedEvaluation('hard_bounce') }));

const increasingPace = () => nextPaceMultiplier(paceInput());
const holdingPace = () => nextPaceMultiplier(paceInput({ evaluation: cleanEvaluation(0) }));
const decreasingPace = () =>
	nextPaceMultiplier(paceInput({ evaluation: breachedEvaluation('hard_bounce') }));

describe('composeActuators — a cell never increases both dials in one window', () => {
	it('defers the PACE increase when the share increased', () => {
		const share = increasingShare();
		const pace = increasingPace();
		expect(share.direction).toBe('increase');
		expect(pace.direction).toBe('increase');

		const composed = composeActuators({ share, pace });
		expect(composed.isPaceDeferred).toBe(true);
		expect(composed.pace.direction).toBe('hold');
		expect(composed.pace.multiplier).toBe(pace.fromMultiplier);
		expect(composed.pace.reason).toBe('share_moved_first');
	});

	it('leaves the SHARE decision exactly as it was — share moves first', () => {
		const share = increasingShare();
		const composed = composeActuators({ share, pace: increasingPace() });
		expect(composed.share).toEqual(share);
	});

	it('does not freeze or penalise the dial it held back', () => {
		const composed = composeActuators({ share: increasingShare(), pace: increasingPace() });
		expect(composed.pace.freeze).toBeUndefined();
		// The day is NOT counted, so the deferred step is taken tomorrow rather
		// than silently spent tonight.
		expect(composed.pace.countedUtcDay).toBeUndefined();
	});

	it('lets the pace increase through when the share only held', () => {
		const composed = composeActuators({ share: holdingShare(), pace: increasingPace() });
		expect(composed.isPaceDeferred).toBe(false);
		expect(composed.pace.direction).toBe('increase');
		expect(composed.pace.multiplier).toBeCloseTo(1 + PACE_AIMD.increaseStep, 5);
	});

	it('lets the pace increase through when the share RETREATED', () => {
		// A share retreat is not a reason to ration the other dial; only a share
		// INCREASE is, because only two increases together are unreadable.
		const composed = composeActuators({ share: decreasingShare(), pace: increasingPace() });
		expect(composed.isPaceDeferred).toBe(false);
		expect(composed.pace.direction).toBe('increase');
	});
});

describe('composeActuators — retreats are never rationed', () => {
	it('both dials may retreat in the same window', () => {
		const composed = composeActuators({ share: decreasingShare(), pace: decreasingPace() });
		expect(composed.isPaceDeferred).toBe(false);
		expect(composed.share?.direction).toBe('decrease');
		expect(composed.pace.direction).toBe('decrease');
		expect(composed.pace.freeze?.origin).toBe('gate_breach');
	});

	it('a pace retreat is untouched by a share increase', () => {
		const composed = composeActuators({ share: increasingShare(), pace: decreasingPace() });
		expect(composed.isPaceDeferred).toBe(false);
		expect(composed.pace.direction).toBe('decrease');
	});

	it('two holds compose to two holds', () => {
		const composed = composeActuators({ share: holdingShare(), pace: holdingPace() });
		expect(composed.isPaceDeferred).toBe(false);
		expect(composed.pace.direction).toBe('hold');
	});
});

describe('composeActuators — standalone is the degenerate case, not a branch', () => {
	it('passes the pace decision through untouched when there is no share actuator', () => {
		const pace = increasingPace();
		const composed = composeActuators({ share: null, pace });
		expect(composed.share).toBeNull();
		expect(composed.isPaceDeferred).toBe(false);
		expect(composed.pace).toEqual(pace);
	});

	it('a standalone cell still ramps on the pace dial alone', () => {
		let state = paceState();
		const composed = composeActuators({
			share: null,
			pace: nextPaceMultiplier(paceInput({ pace: state, now: NOW })),
		});
		state = { ...state, multiplier: composed.pace.multiplier };
		expect(state.multiplier).toBeGreaterThan(1);
	});
});

/**
 * THE INTERLOCK LASTS A WINDOW, NOT A TICK — the claim the card actually makes.
 *
 * `composeActuators` sees ONE tick. The controller cron ticks HOURLY while the
 * share's evaluation window is `RAMP_AIMD.evaluationWindowMs`, so an interlock
 * that lived only inside the call would postpone the pace step by an hour: the
 * next tick finds the share holding on `window_open`, the interlock does not
 * fire, and the reputation-bearing dial takes its step inside the same window
 * the share just moved in. That is the failure this suite exists to pin, so it
 * ticks the controller across a whole window rather than calling it once.
 *
 * The persistence below is `rampControllerCron`'s, field for field: only a
 * COUNTED window moves `lastCountedAt`, only a COUNTED day moves the pace
 * anchor, and `paceDeferredAt` is stamped on the tick the interlock fires.
 */
describe('composeActuators — the interlock survives the whole evaluation window', () => {
	/** One cell's persisted state, as the cron writes it back after each tick. */
	interface CellRow {
		mix: ReturnType<typeof mixState>;
		pace: PaceState;
	}

	function tick(row: CellRow, now: number): { row: CellRow; composed: ComposedActuators } {
		const evaluation = cleanEvaluation(3, now);
		const share = nextShare(controllerInput({ mix: row.mix, evaluation, now }));
		const pace = nextPaceMultiplier(paceInput({ pace: row.pace, evaluation, now }));
		const composed = composeActuators({ share, pace });
		return {
			composed,
			row: {
				mix: {
					...row.mix,
					share: share.share,
					cleanStreak: share.cleanStreak,
					lastCountedAt: share.countedAt ?? row.mix.lastCountedAt,
				},
				pace: {
					...row.pace,
					multiplier: composed.pace.multiplier,
					cleanStreak: composed.pace.cleanStreak,
					lastEvaluatedUtcDay: composed.pace.countedUtcDay ?? row.pace.lastEvaluatedUtcDay,
					deferredAt: composed.isPaceDeferred ? now : row.pace.deferredAt,
				},
			},
		};
	}

	/**
	 * A cell one step below its phase ceiling. The step at T0 takes it TO the
	 * ceiling, so the share cannot increase again when its window reopens — which
	 * is what isolates the pace dial's owed step at the boundary instead of simply
	 * re-triggering the interlock (that case is asserted separately below).
	 */
	const atCeilingNextStep = (): CellRow => ({
		mix: mixState({ share: 0.2, phaseCeiling: 0.25, cleanStreak: 3 }),
		pace: paceState({ cleanStreak: 3 }),
	});

	it('withholds the pace step for the whole window and takes it on the first tick after', () => {
		let row = atCeilingNextStep();

		// T0 — the share increases and the pace step is deferred.
		const first = tick(row, NOW);
		row = first.row;
		expect(first.composed.share?.direction).toBe('increase');
		expect(first.composed.isPaceDeferred).toBe(true);
		expect(first.composed.pace.direction).toBe('hold');
		expect(row.pace.multiplier).toBe(PACE_INITIAL_MULTIPLIER);
		expect(row.pace.deferredAt).toBe(NOW);
		// The day was NOT counted, so nothing here spent the step that was withheld.
		expect(row.pace.lastEvaluatedUtcDay).toBeUndefined();

		// T0+1h .. T0+23h — every remaining hourly tick inside the same window.
		for (let hour = 1; hour < 24; hour += 1) {
			const now = NOW + hour * HOUR;
			const result = tick(row, now);
			row = result.row;
			expect(result.composed.share?.direction).toBe('hold');
			// THE PROPERTY: the reputation-bearing dial has not moved, on any of the
			// twenty-three ticks inside the window the share moved in.
			expect(result.composed.pace.direction).toBe('hold');
			expect(result.composed.pace.reason).toBe('share_moved_first');
			expect(row.pace.multiplier).toBe(PACE_INITIAL_MULTIPLIER);
			expect(row.pace.lastEvaluatedUtcDay).toBeUndefined();
		}

		// T0 + one whole window — the step that was owed is finally taken.
		const after = tick(row, NOW + RAMP_AIMD.evaluationWindowMs);
		expect(after.composed.pace.direction).toBe('increase');
		expect(after.composed.pace.reason).toBe('healthy');
		expect(after.row.pace.multiplier).toBeCloseTo(
			PACE_INITIAL_MULTIPLIER + PACE_AIMD.increaseStep,
			5
		);
		// And the day IS counted now, so the guard at rung 8 takes over from here.
		expect(after.row.pace.lastEvaluatedUtcDay).toBeDefined();
	});

	it('still withholds it one minute before the window closes', () => {
		let row = atCeilingNextStep();
		row = tick(row, NOW).row;
		const justInside = tick(row, NOW + RAMP_AIMD.evaluationWindowMs - 60_000);
		expect(justInside.composed.pace.direction).toBe('hold');
		expect(justInside.composed.pace.reason).toBe('share_moved_first');
	});

	it('defers AGAIN when the share takes another step as the window reopens', () => {
		// Share first, always (plan D3). A cell whose share is still climbing keeps
		// deferring the slow dial — that is the fixed order, not a stuck interlock.
		let row: CellRow = {
			mix: mixState({ share: 0.02, phaseCeiling: 1, cleanStreak: 3 }),
			pace: paceState({ cleanStreak: 3 }),
		};
		row = tick(row, NOW).row;
		const reopened = tick(row, NOW + RAMP_AIMD.evaluationWindowMs);
		expect(reopened.composed.share?.direction).toBe('increase');
		expect(reopened.composed.isPaceDeferred).toBe(true);
		expect(reopened.row.pace.multiplier).toBe(PACE_INITIAL_MULTIPLIER);
	});

	it('never rations a RETREAT inside the deferral window', () => {
		let row = atCeilingNextStep();
		row = tick(row, NOW).row;
		expect(row.pace.deferredAt).toBe(NOW);

		// A breach one hour later, still deep inside the share's window.
		const now = NOW + HOUR;
		const evaluation = breachedEvaluation('complaint', { now });
		const composed = composeActuators({
			share: nextShare(controllerInput({ mix: row.mix, evaluation, now })),
			pace: nextPaceMultiplier(paceInput({ pace: row.pace, evaluation, now })),
		});
		expect(composed.pace.direction).toBe('decrease');
		expect(composed.pace.reason).toBe('complaint');
		expect(composed.pace.freeze?.origin).toBe('gate_breach');
	});
});
