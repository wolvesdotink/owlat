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
import { nextShare } from '../controller';
import { nextPaceMultiplier } from '../paceActuator';
import { PACE_AIMD } from '../paceConfig';
import {
	breachedEvaluation,
	cleanEvaluation,
	controllerInput,
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
