/**
 * THE CRON'S TICK CORE, driven with plain objects: the slice a cursor selects,
 * and the plan one managed cell gets — which dials move, whether the row gets
 * the decision or only its lease, and what reaches `auditLogs`.
 *
 * The cron-level half (that this plan is what the shell writes) is
 * `delivery/__tests__/rampControllerShell.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { resolveRampDegradation } from '../degradation';
import { RAMP_FULLY_EQUIPPED } from '../degradationMatrix';
import { PACE_AIMD, PACE_INITIAL_MULTIPLIER } from '../paceConfig';
import {
	decideRampCell,
	planRampSlice,
	RAMP_CELLS_PER_TICK,
	type RampCellDecisionInput,
} from '../tickDecision';
import {
	absent,
	breachedEvaluation,
	CLEAR_SIGNALS,
	controllerInput,
	EXERCISED,
	HOUR,
	mixState,
	NOW,
	paceState,
} from './controllerFixtures';

const GRID = 15;

describe('planRampSlice', () => {
	it.each([
		{ cursor: undefined, plan: { start: 0, end: 5, continueAt: 5 } },
		{ cursor: 0, plan: { start: 0, end: 5, continueAt: 5 } },
		{ cursor: -3, plan: { start: 0, end: 5, continueAt: 5 } },
		{ cursor: Number.NaN, plan: { start: 0, end: 5, continueAt: 5 } },
		{ cursor: Number.POSITIVE_INFINITY, plan: { start: 0, end: 5, continueAt: 5 } },
		{ cursor: 2.9, plan: { start: 2, end: 7, continueAt: 7 } },
		{ cursor: 5, plan: { start: 5, end: 10, continueAt: 10 } },
		{ cursor: 10, plan: { start: 10, end: 15, continueAt: null } },
		{ cursor: 13, plan: { start: 13, end: 15, continueAt: null } },
	])('cursor $cursor → $plan', ({ cursor, plan }) => {
		expect(planRampSlice(cursor, GRID)).toEqual(plan);
	});

	it.each([15, 16, 1e9])('a cursor past the grid (%s) has nothing to do', (cursor) => {
		expect(planRampSlice(cursor, GRID)).toBeNull();
	});

	it('covers the grid in ticks of RAMP_CELLS_PER_TICK, each cell once', () => {
		const visited: number[] = [];
		let cursor: number | undefined;
		for (let tick = 0; tick < GRID; tick += 1) {
			const plan = planRampSlice(cursor, GRID);
			if (plan === null) break;
			expect(plan.end - plan.start).toBeLessThanOrEqual(RAMP_CELLS_PER_TICK);
			for (let index = plan.start; index < plan.end; index += 1) visited.push(index);
			if (plan.continueAt === null) break;
			cursor = plan.continueAt;
		}
		expect(visited).toEqual(Array.from({ length: GRID }, (_, index) => index));
	});
});

const EQUIPPED = resolveRampDegradation({ presence: RAMP_FULLY_EQUIPPED, provider: 'gmail' });
const STANDALONE = resolveRampDegradation({
	presence: absent('reference_transport'),
	provider: 'gmail',
});

/** A cell whose share and pace dial both earned a step this window. */
function cellInput(overrides: Partial<RampCellDecisionInput> = {}): RampCellDecisionInput {
	return {
		input: controllerInput({
			mix: mixState({ share: 0.2, phaseCeiling: 0.25, cleanStreak: 3 }),
		}),
		degradation: EQUIPPED,
		pace: paceState({ cleanStreak: 3 }),
		control: { pausedAt: undefined, pinnedShare: undefined },
		utilisation: EXERCISED,
		isKillSwitchEngaged: false,
		now: NOW,
		...overrides,
	};
}

describe('decideRampCell', () => {
	it('gives the same plan for the same input', () => {
		expect(decideRampCell(cellInput())).toEqual(decideRampCell(cellInput()));
	});

	it('defers the pace step when the share moves first, and audits the change', () => {
		const plan = decideRampCell(cellInput());
		expect(plan.decision.direction).toBe('increase');
		expect(plan.isPaceDeferred).toBe(true);
		expect(plan.pace.direction).toBe('hold');
		expect(plan.pace.reason).toBe('share_moved_first');
		expect(plan.recordedPace).toEqual({
			decision: plan.pace,
			utilisation: EXERCISED,
			isDeferred: true,
		});
		expect(plan.write).toEqual({
			kind: 'apply',
			audit: {
				cell: 'campaign:gmail',
				fromShare: 0.2,
				toShare: plan.decision.share,
				direction: 'increase',
				reason: plan.decision.reason,
				verdict: plan.decision.verdict,
				fromPaceMultiplier: PACE_INITIAL_MULTIPLIER,
				toPaceMultiplier: PACE_INITIAL_MULTIPLIER,
				paceDirection: 'hold',
				paceReason: 'share_moved_first',
			},
		});
	});

	it('a pace-actuated cell hands the composition no share, so its pace step is not deferred', () => {
		expect(STANDALONE.actuator).toBe('pace');
		const plan = decideRampCell(cellInput({ degradation: STANDALONE }));
		expect(plan.decision.direction).toBe('increase');
		expect(plan.isPaceDeferred).toBe(false);
		expect(plan.pace.direction).toBe('increase');
		expect(plan.pace.multiplier).toBeGreaterThan(PACE_INITIAL_MULTIPLIER);
	});

	it('an operator pause suppresses the increase on both dials', () => {
		const plan = decideRampCell(
			cellInput({ control: { pausedAt: NOW - 1, pinnedShare: undefined } })
		);
		expect(plan.decision.direction).toBe('hold');
		expect(plan.decision.share).toBe(0.2);
		expect(plan.pace.direction).toBe('hold');
		expect(plan.pace.multiplier).toBe(PACE_INITIAL_MULTIPLIER);
		// A suppressed increase is not an increase to defer.
		expect(plan.isPaceDeferred).toBe(false);
	});

	it('an operator pin caps the share and leaves the pace dial alone', () => {
		const plan = decideRampCell(cellInput({ control: { pausedAt: undefined, pinnedShare: 0.2 } }));
		expect(plan.decision.share).toBe(0.2);
		expect(plan.decision.direction).toBe('hold');
		expect(plan.pace.direction).toBe('increase');
	});

	it('a paused controller renews only the lease and logs nothing', () => {
		const plan = decideRampCell(
			cellInput({
				input: controllerInput({ isKillSwitchEngaged: true }),
				isKillSwitchEngaged: true,
			})
		);
		expect(plan.decision.reason).toBe('kill_switch');
		expect(plan.write).toEqual({ kind: 'lease' });
	});

	it('an ordinary hold is applied but stays out of the audit log', () => {
		const plan = decideRampCell(
			cellInput({
				input: controllerInput({ evaluation: null }),
				pace: paceState(),
			})
		);
		expect(plan.decision.direction).toBe('hold');
		expect(plan.pace.direction).toBe('hold');
		expect(plan.write).toEqual({ kind: 'apply', audit: null });
	});

	it('a hard stop retreats both dials and names neither a gate nor a pin it did not touch', () => {
		const signals = { ...CLEAR_SIGNALS, isPoolBlocklisted: true };
		const plan = decideRampCell(
			cellInput({
				input: controllerInput({ mix: mixState({ share: 0.5 }), signals }),
				pace: paceState({ multiplier: 1 }),
			})
		);
		expect(plan.write).toEqual({
			kind: 'apply',
			audit: {
				cell: 'campaign:gmail',
				fromShare: 0.5,
				toShare: 0,
				direction: 'decrease',
				reason: plan.decision.reason,
				verdict: plan.decision.verdict,
				fromPaceMultiplier: 1,
				toPaceMultiplier: PACE_AIMD.multiplierFloor,
				paceDirection: 'decrease',
				paceReason: plan.pace.reason,
			},
		});
	});

	it('a pace retreat on a cell whose share held is still audited', () => {
		// The share sits inside an earlier cooldown, so it answers `frozen` and
		// changes nothing; the pace dial has its own freeze column and retreats.
		const evaluation = breachedEvaluation('hard_bounce');
		const plan = decideRampCell(
			cellInput({
				input: controllerInput({
					mix: mixState({ share: 0.5, frozenUntil: NOW + HOUR, freezeReason: 'gate_breach' }),
					evaluation,
				}),
				pace: paceState({ multiplier: 1 }),
			})
		);
		expect(plan.decision.direction).toBe('hold');
		expect(plan.decision.freeze?.ladderMs).toBeUndefined();
		expect(plan.pace.direction).toBe('decrease');
		expect(plan.write).toMatchObject({
			kind: 'apply',
			audit: { fromShare: 0.5, toShare: 0.5, direction: 'hold', paceDirection: 'decrease' },
		});
	});
});
