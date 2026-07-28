/**
 * THE COOLDOWN LADDER (plan D9): 6h, DOUBLING on a repeat within 24h, capped at
 * 48h — the shape of the shipped MTA circuit breaker, so an operator has one
 * back-off model to hold in their head rather than two.
 *
 * And the property the ladder exists for: while a cell is frozen it does not
 * move, however good its gates look.
 */

import { describe, expect, it } from 'vitest';
import { nextShare } from '../controller';
import { nextCooldownMs, RAMP_AIMD } from '../controllerConfig';
import {
	breachedEvaluation,
	cleanEvaluation,
	controllerInput,
	DAY,
	HOUR,
	mixState,
	NOW,
} from './controllerFixtures';

describe('nextCooldownMs', () => {
	it('starts at 6h for a cell that has never been frozen', () => {
		expect(nextCooldownMs(mixState(), NOW)).toBe(6 * HOUR);
	});

	it('doubles on a repeat inside the 24h window', () => {
		const after = (previous: number) =>
			nextCooldownMs(mixState({ cooldownMs: previous, freezeStartedAt: NOW - 12 * HOUR }), NOW);
		expect(after(6 * HOUR)).toBe(12 * HOUR);
		expect(after(12 * HOUR)).toBe(24 * HOUR);
		expect(after(24 * HOUR)).toBe(48 * HOUR);
	});

	it('caps at 48h however many repeats accumulate', () => {
		expect(
			nextCooldownMs(mixState({ cooldownMs: 48 * HOUR, freezeStartedAt: NOW - HOUR }), NOW)
		).toBe(48 * HOUR);
		expect(
			nextCooldownMs(mixState({ cooldownMs: 96 * HOUR, freezeStartedAt: NOW - HOUR }), NOW)
		).toBe(RAMP_AIMD.cooldownMaxMs);
	});

	it('restarts at the base once the 24h repeat window has passed', () => {
		expect(
			nextCooldownMs(mixState({ cooldownMs: 24 * HOUR, freezeStartedAt: NOW - 24 * HOUR - 1 }), NOW)
		).toBe(6 * HOUR);
	});

	it('restarts at the base rather than propagating an unreadable ladder position', () => {
		for (const corrupt of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
			expect(
				nextCooldownMs(mixState({ cooldownMs: corrupt, freezeStartedAt: NOW - HOUR }), NOW)
			).toBe(6 * HOUR);
		}
	});

	it('ignores a freeze that claims to have started in the future', () => {
		expect(
			nextCooldownMs(mixState({ cooldownMs: 24 * HOUR, freezeStartedAt: NOW + DAY }), NOW)
		).toBe(6 * HOUR);
	});
});

describe('freezes through the decision function', () => {
	it('records the ladder position it imposed so the next breach can double it', () => {
		const first = nextShare(
			controllerInput({
				mix: mixState({ share: 0.4 }),
				evaluation: breachedEvaluation('complaint'),
			})
		);
		expect(first.freeze?.ladderMs).toBe(6 * HOUR);
		expect(first.freeze?.until).toBe(NOW + 6 * HOUR);

		const second = nextShare(
			controllerInput({
				now: NOW + 7 * HOUR,
				mix: mixState({
					share: first.share,
					cooldownMs: first.freeze?.ladderMs,
					freezeStartedAt: NOW,
					frozenUntil: first.freeze?.until,
				}),
				evaluation: breachedEvaluation('complaint', { now: NOW + 7 * HOUR }),
			})
		);
		expect(second.freeze?.ladderMs).toBe(12 * HOUR);
		expect(second.freeze?.until).toBe(NOW + 7 * HOUR + 12 * HOUR);
	});

	// AN INFRASTRUCTURE FREEZE IS NOT A LADDER RUNG. A breaker freeze in between
	// two gate breaches must not re-arm the "repeat within 24h" window: the
	// second breach is 31h after the first and starts again at the base, even
	// though the cell was frozen for infrastructure reasons an hour ago.
	it('does not let a hard-stop freeze inflate the next gate cooldown', () => {
		const breach = nextShare(
			controllerInput({
				mix: mixState({ share: 0.4 }),
				evaluation: breachedEvaluation('complaint'),
			})
		);
		expect(breach.freeze?.ladderMs).toBe(6 * HOUR);

		const breaker = nextShare(
			controllerInput({
				now: NOW + 30 * HOUR,
				mix: mixState({
					share: breach.share,
					cooldownMs: breach.freeze?.ladderMs,
					freezeStartedAt: NOW,
				}),
				signals: { isSendingAllowed: true, isCircuitBreakerOpen: true, isPoolBlocklisted: false },
			})
		);
		// A hard stop imposes an expiry but claims NO ladder rung — which is what
		// keeps the shell from re-stamping the ladder's anchor.
		expect(breaker.freeze?.ladderMs).toBeUndefined();

		const second = nextShare(
			controllerInput({
				now: NOW + 31 * HOUR,
				mix: mixState({
					share: breaker.share,
					cooldownMs: breach.freeze?.ladderMs,
					freezeStartedAt: NOW,
				}),
				evaluation: breachedEvaluation('complaint', { now: NOW + 31 * HOUR }),
			})
		);
		expect(second.freeze?.ladderMs).toBe(6 * HOUR);
	});

	it('holds a frozen cell against a perfect gate sweep', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.2, cleanStreak: 99, frozenUntil: NOW + HOUR }),
				evaluation: cleanEvaluation(99),
			})
		);
		expect(decision.reason).toBe('frozen');
		expect(decision.share).toBe(0.2);
		expect(decision.direction).toBe('hold');
	});

	it('releases the cell the instant the freeze expires', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.2, cleanStreak: 3, frozenUntil: NOW }),
				evaluation: cleanEvaluation(3),
			})
		);
		expect(decision.reason).toBe('healthy');
		expect(decision.share).toBe(0.25);
	});
});
