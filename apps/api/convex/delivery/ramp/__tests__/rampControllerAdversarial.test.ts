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
import { capacityCeiling, isEvaluationWindowElapsed, nextShare } from '../controller';
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

	it('a CRAFTED graduation pin cannot buy more than one step either', () => {
		// The most valuable row an attacker (or a corrupt write) could plant: a
		// graduation instant plus an ancient green clock on a cell sitting at the
		// initial 2%. The graduation rung may only hold or lower, so this is worth
		// exactly one +5pp step — the same as any other clean window.
		const decision = nextShare(
			controllerInput({
				mix: mixState({
					share: 0.02,
					cleanStreak: 1,
					graduatedAt: NOW - 6 * DAY,
					greenSince: NOW - 20 * DAY,
				}),
				evaluation: forgedPerfection(),
			})
		);
		expect(decision.share).toBe(0.07);
		expect(decision.reason).toBe('healthy');
		expect(decision.share).toBeLessThanOrEqual(0.02 + 0.05);
	});

	it('a crafted pin cannot buy a step the window has already been paid for', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({
					share: 0.02,
					// K_CLEAN already satisfied, so the window anchor is the ONLY thing
					// left between this crafted row and a step.
					cleanStreak: 3,
					graduatedAt: NOW - 6 * DAY,
					greenSince: NOW - 20 * DAY,
					lastCountedAt: NOW - 1_000,
				}),
				evaluation: forgedPerfection(),
			})
		);
		expect(decision.share).toBe(0.02);
		expect(decision.reason).toBe('window_open');
		expect(decision.direction).toBe('hold');
	});

	it('a crafted pin cannot skip K_CLEAN', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({
					share: 0.02,
					graduatedAt: NOW - 6 * DAY,
					greenSince: NOW - 20 * DAY,
				}),
				// One clean window only: nowhere near K_CLEAN.
				evaluation: cleanEvaluation(0),
			})
		);
		expect(decision.share).toBe(0.02);
		expect(decision.reason).toBe('building_confidence');
	});

	it('replaying the SAME evaluation INSIDE one window buys nothing at all', () => {
		const evaluation = forgedPerfection();
		let share = 0.4;
		let lastCountedAt: number | undefined;
		// The first call has no anchor to have counted against, so it buys the one
		// step a clean window is worth...
		const first = nextShare(controllerInput({ mix: mixState({ share }), evaluation }));
		share = first.share;
		lastCountedAt = first.countedAt ?? lastCountedAt;
		expect(share).toBe(0.45);
		expect(lastCountedAt).toBe(NOW);

		// ...and every replay against the SAME window buys zero, however many times
		// it is fired. Carrying the anchor forward is what the cron does.
		for (let replay = 0; replay < 2; replay += 1) {
			const decision = nextShare(
				controllerInput({ mix: mixState({ share, cleanStreak: 3, lastCountedAt }), evaluation })
			);
			expect(decision.reason).toBe('window_open');
			expect(decision.direction).toBe('hold');
			expect(decision.share).toBe(0.45);
			// A replay is not a counted window, so it must not push the anchor out.
			expect(decision.countedAt).toBeUndefined();
			share = decision.share;
			lastCountedAt = decision.countedAt ?? lastCountedAt;
		}
		expect(share).toBe(0.45);
	});

	it('buys exactly one step per ELAPSED window, not one per call', () => {
		const evaluation = forgedPerfection();
		let share = 0.4;
		let lastCountedAt: number | undefined;
		let now = NOW;
		for (let window = 0; window < 3; window += 1) {
			const decision = nextShare(
				controllerInput({
					mix: mixState({ share, cleanStreak: 3, lastCountedAt }),
					evaluation,
					now,
				})
			);
			expect(decision.reason).toBe('healthy');
			share = decision.share;
			lastCountedAt = decision.countedAt ?? lastCountedAt;
			now += RAMP_AIMD.evaluationWindowMs;
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
		// The ceiling pulls the cell back hard — but NOT past the soft floor. No
		// gate failed here, and only a gate breach or a hard stop may take a cell
		// to zero; a green cell keeps the trickle that lets it be re-measured.
		expect(decision.share).toBe(0.01);
		expect(decision.reason).toBe('capacity_ceiling');
		expect(decision.direction).toBe('decrease');
	});

	it('cannot turn the ceiling floor into an increase for a cell below it', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.005 }),
				capacity: { warmingCapRemaining: 0, projectedVolume: 1_000 },
			})
		);
		expect(decision.share).toBe(0.005);
		expect(decision.direction).toBe('hold');
	});

	it('never grants graduation off a degenerate green clock', () => {
		for (const greenSince of [0, -1, Number.NaN, NOW + DAY, Number.POSITIVE_INFINITY]) {
			const decision = nextShare(
				controllerInput({ mix: mixState({ share: 1, cleanStreak: 40, greenSince }) })
			);
			// The clock restarts at `now`: a stored instant we cannot trust may only
			// ever DELAY a pin, never grant one.
			expect(decision.reason).not.toBe('graduated');
			expect(decision.graduatedAt).toBeUndefined();
			expect(decision.greenSince).toBe(NOW);
		}
	});

	it('never carries a degenerate graduation instant back onto the row', () => {
		// The pin is the one stored instant a DOWNSTREAM reader acts on, so an
		// unreadable one must not survive a hold: the decision function ignores it
		// either way, but the row it writes back would keep saying "graduated".
		for (const graduatedAt of [0, -1, Number.NaN, NOW + DAY, Number.POSITIVE_INFINITY]) {
			for (const evaluation of [thinEvaluation(3), cleanEvaluation(3)]) {
				const decision = nextShare(
					controllerInput({ mix: mixState({ share: 0.5, graduatedAt }), evaluation })
				);
				expect(decision.graduatedAt).toBeUndefined();
			}
		}
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

describe('the window anchor, read directly', () => {
	// The predicate decides whether a clean window may be SPENT, so its
	// degenerate readings are asserted here rather than inferred through the
	// ladder: absent or unreadable means "never counted" (a cell with no anchor
	// must not be stranded), and AHEAD OF THE CLOCK means "just counted" — the
	// one direction that cannot hand out a step.
	const cases: ReadonlyArray<[string, number | undefined, boolean]> = [
		['no anchor at all', undefined, true],
		['a zero anchor', 0, true],
		['a negative anchor', -1, true],
		['NaN', Number.NaN, true],
		// Both infinities are UNREADABLE rather than "in the future": an anchor no
		// arithmetic can subtract from would strand the cell forever if it counted
		// as one, and the step it unlocks still has to be paid for with a green
		// window and a satisfied K_CLEAN.
		['+Infinity', Number.POSITIVE_INFINITY, true],
		['-Infinity', Number.NEGATIVE_INFINITY, true],
		['an anchor ten days in the future', NOW + 10 * DAY, false],
		['exactly one window ago', NOW - RAMP_AIMD.evaluationWindowMs, true],
		['one millisecond short of a window', NOW - RAMP_AIMD.evaluationWindowMs + 1, false],
		['the current instant', NOW, false],
		['a week ago', NOW - 7 * DAY, true],
	];

	for (const [name, anchor, expected] of cases) {
		it(`${name} reads as ${expected ? 'elapsed' : 'open'}`, () => {
			expect(isEvaluationWindowElapsed(anchor, NOW)).toBe(expected);
		});
	}

	it('an anchor stamped in the future holds the cell instead of unlocking a step', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.4, cleanStreak: 3, lastCountedAt: NOW + 10 * DAY }),
			})
		);
		expect(decision.reason).toBe('window_open');
		expect(decision.share).toBe(0.4);
		expect(decision.countedAt).toBeUndefined();
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
