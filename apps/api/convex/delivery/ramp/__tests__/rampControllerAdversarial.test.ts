/**
 * HOSTILE INPUT. The reviewer's question for this piece is precedence and
 * monotonic safety: prove that NO input — crafted, stale, degenerate or hostile
 * — can increase a share while a hard stop is active or the data is thin.
 *
 * So this file is written as an attack, not as coverage. Each case is an
 * attempt to reach the one branch that raises a share, and each asserts that
 * the attempt failed.
 */

import { describe, expect, it } from 'vitest';
import { capacityCeiling, nextShare } from '../controller';
import { RAMP_AIMD } from '../controllerConfig';
import { aggregateRampGates } from '../gateEvaluation';
import type { RampGateEvaluation } from '../gateTypes';
import type { RampControllerInput } from '../controllerTypes';
import {
	breachedEvaluation,
	cleanEvaluation,
	controllerInput,
	DAY,
	failing,
	mixState,
	NOW,
	passing,
	thinEvaluation,
} from './controllerFixtures';

/** An evaluation crafted to look as green as a caller could possibly make it. */
function forgedPerfection(now = NOW): RampGateEvaluation {
	return {
		...aggregateRampGates({
			perGate: [passing('hard_bounce'), passing('deferral'), passing('complaint')],
			previousCleanStreak: Number.MAX_SAFE_INTEGER,
			now,
		}),
		// Hand-forged fields the aggregator would never emit together.
		cleanStreak: Number.MAX_SAFE_INTEGER,
		verdict: 'pass',
	};
}

const HOSTILE_NUMBERS = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

describe('a crafted snapshot cannot bypass a hard stop', () => {
	const attacks: ReadonlyArray<[string, Partial<RampControllerInput>]> = [
		['kill switch', { isKillSwitchEngaged: true }],
		[
			'abuse status',
			{
				signals: { isSendingAllowed: false, isCircuitBreakerOpen: false, isPoolBlocklisted: false },
			},
		],
		[
			'circuit breaker',
			{ signals: { isSendingAllowed: true, isCircuitBreakerOpen: true, isPoolBlocklisted: false } },
		],
		[
			'critical blocklist',
			{ signals: { isSendingAllowed: true, isCircuitBreakerOpen: false, isPoolBlocklisted: true } },
		],
		['active freeze', { mix: mixState({ share: 0.4, frozenUntil: NOW + DAY }) }],
	];

	for (const [name, overrides] of attacks) {
		it(`never increases past the ${name}`, () => {
			const decision = nextShare(
				controllerInput({
					mix: mixState({ share: 0.4, cleanStreak: Number.MAX_SAFE_INTEGER }),
					evaluation: forgedPerfection(),
					capacity: { warmingCapRemaining: 1e9, projectedVolume: 1 },
					...overrides,
				})
			);
			expect(decision.direction).not.toBe('increase');
			expect(decision.share).toBeLessThanOrEqual(0.4);
		});
	}
});

describe('a forged snapshot cannot buy more than one step', () => {
	it('caps a MAX_SAFE_INTEGER clean streak at exactly one additive step', () => {
		const decision = nextShare(
			controllerInput({ mix: mixState({ share: 0.4 }), evaluation: forgedPerfection() })
		);
		expect(decision.share).toBe(0.45);
		expect(decision.reason).toBe('healthy');
	});

	it('replaying the SAME evaluation still buys only one step per call', () => {
		const evaluation = forgedPerfection();
		let share = 0.4;
		for (let replay = 0; replay < 3; replay += 1) {
			share = nextShare(controllerInput({ mix: mixState({ share }), evaluation })).share;
		}
		expect(share).toBe(0.55);
	});

	it('a stale evaluation is still bounded by the step, never by its age', () => {
		const stale = cleanEvaluation(50, NOW - 400 * DAY);
		const decision = nextShare(
			controllerInput({ mix: mixState({ share: 0.4 }), evaluation: stale })
		);
		expect(decision.share).toBe(0.45);
	});
});

describe('degenerate numbers fail closed', () => {
	it('never increases from a stored share outside [0, 1]', () => {
		for (const share of [-5, -0.0001, 1.5, 42, ...HOSTILE_NUMBERS]) {
			const decision = nextShare(controllerInput({ mix: mixState({ share }) }));
			expect(decision.reason).toBe('share_unreadable');
			expect(decision.direction).toBe('hold');
			expect(decision.share).toBeGreaterThanOrEqual(0);
			expect(decision.share).toBeLessThanOrEqual(1);
		}
	});

	it('holds rather than ramping when the capacity projection is unreadable', () => {
		for (const bad of [...HOSTILE_NUMBERS, -1]) {
			expect(capacityCeiling({ warmingCapRemaining: bad, projectedVolume: 1_000 })).toBeNull();
			expect(capacityCeiling({ warmingCapRemaining: 1_000, projectedVolume: bad })).toBeNull();
			const decision = nextShare(
				controllerInput({
					mix: mixState({ share: 0.3 }),
					capacity: { warmingCapRemaining: bad, projectedVolume: 1_000 },
				})
			);
			expect(decision.direction).toBe('hold');
			expect(decision.reason).toBe('capacity_unknown');
		}
	});

	it('treats a ZERO-VOLUME cell as unconstrained by capacity, not as infinite headroom', () => {
		expect(capacityCeiling({ warmingCapRemaining: 0, projectedVolume: 0 })).toBe(1);
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.3 }),
				capacity: { warmingCapRemaining: 0, projectedVolume: 0 },
				// A cell with no volume cannot reach any sample floor, so the gates hold
				// and the share does not move — the capacity ceiling never gets a say.
				evaluation: thinEvaluation(9),
			})
		);
		expect(decision.share).toBe(0.3);
		expect(decision.reason).toBe('holding');
	});

	it('never divides its way to an increase on a zero cap with real volume', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.3 }),
				capacity: { warmingCapRemaining: 0, projectedVolume: 1_000 },
			})
		);
		expect(decision.share).toBe(0);
		expect(decision.reason).toBe('capacity_ceiling');
	});

	it('snaps a corrupt phase ceiling DOWN to the lowest rung, never up', () => {
		for (const ceiling of [Number.NaN, -1, 0, 0.24, undefined]) {
			const decision = nextShare(
				controllerInput({ mix: mixState({ share: 0.9, phaseCeiling: ceiling }) })
			);
			expect(decision.phaseCeiling).toBe(0.25);
			expect(decision.direction).not.toBe('increase');
		}
		// 1.9 is above every rung: it snaps DOWN to 1, not up to 1.9.
		expect(
			nextShare(controllerInput({ mix: mixState({ share: 0.9, phaseCeiling: 1.9 }) })).phaseCeiling
		).toBe(1);
	});

	it('treats a corrupt clean streak as zero rather than as instant confidence', () => {
		for (const streak of [Number.NaN, Number.POSITIVE_INFINITY, -10]) {
			const decision = nextShare(
				controllerInput({
					mix: mixState({ share: 0.3, cleanStreak: streak }),
					evaluation: { ...cleanEvaluation(0), cleanStreak: streak },
				})
			);
			expect(decision.reason).toBe('building_confidence');
			expect(decision.share).toBe(0.3);
		}
	});
});

describe('clock skew', () => {
	it('refuses to decide against a non-finite clock', () => {
		for (const now of HOSTILE_NUMBERS) {
			const decision = nextShare(controllerInput({ mix: mixState({ share: 0.3 }), now }));
			expect(decision.reason).toBe('clock_unusable');
			expect(decision.share).toBe(0.3);
			expect(decision.frozenUntil).toBeUndefined();
		}
	});

	it('a freeze stamped far in the future still holds the cell', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.3, frozenUntil: NOW + 10_000 * DAY }),
				evaluation: cleanEvaluation(99),
			})
		);
		expect(decision.reason).toBe('frozen');
	});

	it('a non-finite stored freeze does not pin the cell forever', () => {
		const decision = nextShare(
			controllerInput({ mix: mixState({ share: 0.3, frozenUntil: Number.NaN }) })
		);
		expect(decision.reason).toBe('healthy');
	});
});

describe('the tripwire cannot be turned into a decrease on its own', () => {
	it('halves only once a real gate corroborates the seed collapse', () => {
		const alone = nextShare(
			controllerInput({
				mix: mixState({ share: 0.4 }),
				evaluation: breachedEvaluation('seed_placement'),
			})
		);
		expect(alone.share).toBe(0.4);

		const corroborated = nextShare(
			controllerInput({
				mix: mixState({ share: 0.4 }),
				evaluation: aggregateRampGates({
					perGate: [
						passing('hard_bounce'),
						failing('deferral'),
						passing('complaint'),
						failing('seed_placement'),
					],
					previousCleanStreak: 5,
					now: NOW,
				}),
			})
		);
		expect(corroborated.share).toBe(0.2);
		expect(corroborated.reason).toBe('deferral');
		expect(corroborated.frozenUntil).toBe(NOW + RAMP_AIMD.cooldownBaseMs);
	});
});
