/**
 * THE ASYMMETRY (plan D9): cheap to retreat, expensive to advance.
 *
 * Twenty clean windows are what it costs to walk a campaign cell from its
 * opening 2% to 100%. One breached gate halves it. The two numbers in the same
 * file are the point — a change that makes the climb cheaper or the retreat
 * costlier has to break a test here.
 */

import { describe, expect, it } from 'vitest';
import { nextShare } from '../controller';
import { RAMP_AIMD } from '../controllerConfig';
import { RAMP_STREAM_CONFIGS } from '../gateConfig';
import {
	breachedEvaluation,
	cleanEvaluation,
	controllerInput,
	DAY,
	HOUR,
	mixState,
	NOW,
} from './controllerFixtures';

describe('additive increase', () => {
	it('walks 0.02 to 1.0 in 20 clean promotions on the plan arithmetic', () => {
		let share = RAMP_STREAM_CONFIGS.campaign.initialShareFraction as number;
		const observed: number[] = [];
		for (let window = 0; window < 20; window += 1) {
			const decision = nextShare(
				controllerInput({
					// K_CLEAN is already satisfied every window: this measures the STEP,
					// not the confidence requirement (which has its own test).
					mix: mixState({ share, cleanStreak: 3 }),
					evaluation: cleanEvaluation(3),
				})
			);
			expect(decision.reason).toBe(share >= 1 ? 'phase_ceiling' : 'healthy');
			share = decision.share;
			observed.push(share);
		}
		expect(observed[0]).toBe(0.07);
		expect(observed[18]).toBe(0.97);
		expect(share).toBe(1);
	});

	it('needs nineteen windows to pass 0.97 — the twentieth is what reaches 1.0', () => {
		let share = 0.02;
		for (let window = 0; window < 19; window += 1) {
			share = nextShare(controllerInput({ mix: mixState({ share, cleanStreak: 3 }) })).share;
		}
		expect(share).toBe(0.97);
		expect(share).toBeLessThan(1);
	});
});

describe('multiplicative decrease', () => {
	it('halves a fully ramped cell on ONE breach', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 1, cleanStreak: 20 }),
				evaluation: breachedEvaluation('complaint', { previousCleanStreak: 20 }),
			})
		);
		expect(decision.share).toBe(0.5);
		expect(decision.direction).toBe('decrease');
		expect(decision.reason).toBe('complaint');
	});

	it('throws twenty clean windows away in one: the streak resets to zero', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 1, cleanStreak: 20 }),
				evaluation: breachedEvaluation('hard_bounce', { previousCleanStreak: 20 }),
			})
		);
		expect(decision.cleanStreak).toBe(0);
	});

	it('holds a SOFT failure at the floor — never fully zero, so the cell can recover', () => {
		let share = 0.02;
		for (let breach = 0; breach < 10; breach += 1) {
			share = nextShare(
				controllerInput({
					mix: mixState({ share }),
					evaluation: breachedEvaluation('complaint'),
				})
			).share;
		}
		expect(share).toBe(RAMP_AIMD.shareFloor);
		expect(share).toBeGreaterThan(0);
	});

	it('sends a HARD stop to zero, ignoring the soft floor', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: RAMP_AIMD.shareFloor }),
				signals: { isSendingAllowed: true, isCircuitBreakerOpen: false, isPoolBlocklisted: true },
			})
		);
		expect(decision.share).toBe(0);
		expect(decision.reason).toBe('dnsbl');
	});

	it('recovers from the floor by the same slow climb, not a jump back', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: RAMP_AIMD.shareFloor, cleanStreak: 3, frozenUntil: NOW - 1 }),
			})
		);
		expect(decision.share).toBe(0.06);
		expect(decision.reason).toBe('healthy');
	});
});

/**
 * ONE WINDOW, COUNTED ONCE.
 *
 * The cron ticks HOURLY while the gates read a 24-HOUR window of outcomes. If
 * every tick counted, K_CLEAN = 3 would be bought with three overlapping reads
 * of the same day an hour apart, and the twenty steps above would fit inside a
 * single day. That is D9's "expensive to advance" half deleted, so it has a test.
 */
describe('the evaluation window is counted once', () => {
	const clean = () =>
		controllerInput({
			mix: mixState({ share: 0.1, cleanStreak: 3, lastCountedAt: NOW - HOUR }),
			evaluation: cleanEvaluation(3),
		});

	it('holds a green cell that already counted this window, naming why', () => {
		const decision = nextShare(clean());
		expect(decision.share).toBe(0.1);
		expect(decision.direction).toBe('hold');
		expect(decision.reason).toBe('window_open');
		// The streak does not grow either: an hour-old read is the same evidence.
		expect(decision.cleanStreak).toBe(3);
		expect(decision.countedAt).toBeUndefined();
	});

	it('increases once a whole window has elapsed, and re-anchors the window', () => {
		const decision = nextShare(
			controllerInput({
				...clean(),
				mix: mixState({
					share: 0.1,
					cleanStreak: 3,
					lastCountedAt: NOW - RAMP_AIMD.evaluationWindowMs,
				}),
			})
		);
		expect(decision.share).toBe(0.15);
		expect(decision.reason).toBe('healthy');
		expect(decision.cleanStreak).toBe(4);
		expect(decision.countedAt).toBe(NOW);
	});

	it('costs three DAYS, not three hours, to reach K_CLEAN from a cold streak', () => {
		let mix = mixState({ share: 0.02, cleanStreak: 0, lastCountedAt: undefined });
		let counted = 0;
		let increases = 0;
		// A full day of hourly ticks, three times over.
		for (let tick = 0; tick < 72; tick += 1) {
			const now = NOW + tick * HOUR;
			const decision = nextShare(
				controllerInput({ mix, evaluation: cleanEvaluation(mix.cleanStreak ?? 0), now })
			);
			if (decision.countedAt !== undefined) counted += 1;
			if (decision.direction === 'increase') increases += 1;
			mix = mixState({
				share: decision.share,
				cleanStreak: decision.cleanStreak,
				lastCountedAt: decision.countedAt ?? mix.lastCountedAt,
			});
		}
		// Seventy-two hourly ticks buy exactly three counted windows...
		expect(counted).toBe(3);
		// ...and exactly ONE additive step, taken once the third one landed.
		expect(increases).toBe(1);
		expect(mix.share).toBe(0.07);
	});

	it('never lets a window anchor in the FUTURE unlock an increase', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.1, cleanStreak: 9, lastCountedAt: NOW + 10 * DAY }),
				evaluation: cleanEvaluation(9),
			})
		);
		expect(decision.direction).toBe('hold');
		expect(decision.reason).toBe('window_open');
	});
});
