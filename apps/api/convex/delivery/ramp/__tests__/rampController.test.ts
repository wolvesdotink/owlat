/**
 * THE DECISION TABLE. Every branch of `nextShare`, asserted on BOTH the share
 * it produces and the reason string it produces — a controller that lands on
 * the right number for the wrong reason is a controller nobody can debug.
 *
 * Ordered the way the function is ordered, because the ORDER is the safety
 * property: each hard stop is asserted to win against the one below it.
 */

import { describe, expect, it } from 'vitest';
import { nextShare } from '../controller';
import { RAMP_AIMD } from '../controllerConfig';
import { RAMP_STREAM_CONFIGS } from '../gateConfig';
import type { RampFreezeOrigin } from '../controllerTypes';
import {
	breachedEvaluation,
	cleanEvaluation,
	CLEAR_SIGNALS,
	controllerInput,
	GMAIL_CAMPAIGN,
	HOUR,
	mixState,
	NOW,
	OPEN_CAPACITY,
	thinEvaluation,
} from './controllerFixtures';

describe('nextShare — hard stops, in precedence order', () => {
	it('pins every cell when the kill switch is engaged, before anything else', () => {
		const decision = nextShare(
			controllerInput({
				isKillSwitchEngaged: true,
				mix: mixState({ share: 0.4 }),
				// Every hard stop is ALSO active: the kill switch still wins.
				signals: { isSendingAllowed: false, isCircuitBreakerOpen: true, isPoolBlocklisted: true },
			})
		);
		expect(decision.share).toBe(0.4);
		expect(decision.reason).toBe('kill_switch');
		expect(decision.direction).toBe('hold');
	});

	it('holds against an unusable clock rather than deciding', () => {
		const decision = nextShare(controllerInput({ now: Number.NaN, mix: mixState({ share: 0.3 }) }));
		expect(decision.share).toBe(0.3);
		expect(decision.reason).toBe('clock_unusable');
	});

	it('zeroes the share when the abuse status forbids sending, beating the breaker', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.6 }),
				signals: { isSendingAllowed: false, isCircuitBreakerOpen: true, isPoolBlocklisted: true },
			})
		);
		expect(decision.share).toBe(0);
		expect(decision.reason).toBe('abuse_status');
		expect(decision.freeze?.until).toBeUndefined();
	});

	it('halves and freezes for 6h when the circuit breaker is open, beating the blocklist', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.6 }),
				signals: { isSendingAllowed: true, isCircuitBreakerOpen: true, isPoolBlocklisted: true },
			})
		);
		expect(decision.share).toBe(0.3);
		expect(decision.reason).toBe('breaker');
		expect(decision.freeze?.until).toBe(NOW + RAMP_AIMD.breakerFreezeMs);
		// The freeze is ATTRIBUTED, which is what lets the next tick tell its own
		// freeze from an unrelated cooldown it must not be absorbed by.
		expect(decision.freeze?.origin).toBe('breaker');
		// A hard-stop freeze does NOT advance the gate-cooldown ladder.
		expect(decision.freeze?.ladderMs).toBeUndefined();
	});

	it('does not re-halve on an open breaker while the freeze it stamped is running', () => {
		// The breaker is a CONDITION that persists across hourly ticks. It still
		// hard-stops here — the reason is `breaker`, not the `frozen` rung below
		// it, and the streak stays revoked — but the retreat is charged once per
		// freeze window rather than once per tick.
		const decision = nextShare(
			controllerInput({
				mix: mixState({
					share: 0.3,
					cleanStreak: 5,
					frozenUntil: NOW + RAMP_AIMD.breakerFreezeMs,
					freezeReason: 'breaker',
				}),
				signals: { isSendingAllowed: true, isCircuitBreakerOpen: true, isPoolBlocklisted: false },
			})
		);
		expect(decision.share).toBe(0.3);
		expect(decision.reason).toBe('breaker');
		expect(decision.direction).toBe('hold');
		expect(decision.cleanStreak).toBe(0);
		// No NEW freeze: the one already in force is what holds the cell.
		expect(decision.freeze?.until).toBeUndefined();
		expect(decision.freeze?.origin).toBeUndefined();
	});

	// THE DISCRIMINATING PAIR. The suppression above is the BREAKER'S OWN freeze
	// declining to re-charge one incident; it is emphatically not "any freeze
	// suppresses the breaker". A gate-breach cooldown can run for 48h, and if it
	// could absorb this rung the cell would keep its full pre-breaker share for
	// two days with the breaker open — the hard stop deleted by an unrelated
	// timer. Same fixture, one field different, opposite outcome.
	const FOREIGN_FREEZES: readonly (readonly [string, RampFreezeOrigin | undefined])[] = [
		['a gate-breach cooldown', 'gate_breach'],
		['a blocklist freeze', 'dnsbl'],
		['an unattributed legacy freeze', undefined],
	];
	for (const [label, origin] of FOREIGN_FREEZES) {
		it(`still halves on a newly-open breaker under ${label}`, () => {
			const decision = nextShare(
				controllerInput({
					mix: mixState({
						share: 0.4,
						frozenUntil: NOW + RAMP_AIMD.cooldownMaxMs,
						freezeReason: origin,
					}),
					signals: {
						isSendingAllowed: true,
						isCircuitBreakerOpen: true,
						isPoolBlocklisted: false,
					},
				})
			);
			expect(decision.share).toBe(0.2);
			expect(decision.reason).toBe('breaker');
			// And the retreat re-stamps the freeze as the BREAKER'S, so the next tick
			// holds rather than halving a second time for the same incident. The
			// EXPIRY is the later of the two: the breaker's 6h does not cut the 48h
			// the cell was already serving, because a freeze is only ever lengthened.
			expect(decision.freeze?.until).toBe(NOW + RAMP_AIMD.cooldownMaxMs);
			expect(decision.freeze?.origin).toBe('breaker');
		});
	}

	it('lengthens rather than replaces when the new freeze outlasts the running one', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({
					share: 0.4,
					// One hour left to serve; the blocklist's 24h is longer, so it wins.
					frozenUntil: NOW + HOUR,
					freezeReason: 'gate_breach',
				}),
				signals: { isSendingAllowed: true, isCircuitBreakerOpen: false, isPoolBlocklisted: true },
			})
		);
		expect(decision.share).toBe(0);
		expect(decision.freeze?.until).toBe(NOW + RAMP_AIMD.blocklistFreezeMs);
		expect(decision.freeze?.origin).toBe('dnsbl');
	});

	it('halves again once the breaker freeze has expired and the breaker is still open', () => {
		const decision = nextShare(
			controllerInput({
				now: NOW + 7 * HOUR,
				mix: mixState({
					share: 0.3,
					frozenUntil: NOW + RAMP_AIMD.breakerFreezeMs,
					freezeReason: 'breaker',
				}),
				signals: { isSendingAllowed: true, isCircuitBreakerOpen: true, isPoolBlocklisted: false },
			})
		);
		expect(decision.share).toBe(0.15);
		expect(decision.reason).toBe('breaker');
		expect(decision.freeze?.until).toBe(NOW + 7 * HOUR + RAMP_AIMD.breakerFreezeMs);
	});

	it('zeroes and freezes for 24h on a critical pool blocklist listing', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.6 }),
				signals: { isSendingAllowed: true, isCircuitBreakerOpen: false, isPoolBlocklisted: true },
			})
		);
		expect(decision.share).toBe(0);
		expect(decision.reason).toBe('dnsbl');
		expect(decision.freeze?.until).toBe(NOW + RAMP_AIMD.blocklistFreezeMs);
		expect(decision.freeze?.origin).toBe('dnsbl');
	});

	it('holds a frozen cell however green its gates are', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.2, frozenUntil: NOW + 1, cleanStreak: 9 }),
				evaluation: cleanEvaluation(9),
			})
		);
		expect(decision.share).toBe(0.2);
		expect(decision.reason).toBe('frozen');
	});
});

describe('nextShare — gate verdicts', () => {
	it('halves to the floor and names the failing gate', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.4, cleanStreak: 5 }),
				evaluation: breachedEvaluation('hard_bounce', { previousCleanStreak: 5 }),
			})
		);
		expect(decision.share).toBe(0.2);
		expect(decision.reason).toBe('hard_bounce');
		expect(decision.failedGate).toBe('hard_bounce');
		expect(decision.direction).toBe('decrease');
		expect(decision.cleanStreak).toBe(0);
		expect(decision.freeze?.until).toBe(NOW + RAMP_AIMD.cooldownBaseMs);
		expect(decision.freeze?.ladderMs).toBe(RAMP_AIMD.cooldownBaseMs);
	});

	it('drops a HALT straight to the floor rather than one step down', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.8 }),
				evaluation: breachedEvaluation('deferral', { halt: true }),
			})
		);
		expect(decision.share).toBe(RAMP_AIMD.shareFloor);
		expect(decision.reason).toBe('deferral');
		expect(decision.verdict).toBe('halt');
	});

	it('HOLDS a tripwire that fired alone until another gate corroborates it', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.4 }),
				evaluation: breachedEvaluation('seed_placement'),
			})
		);
		expect(decision.share).toBe(0.4);
		expect(decision.reason).toBe('awaiting_corroboration');
		expect(decision.direction).toBe('hold');
		expect(decision.failedGate).toBe('seed_placement');
	});

	it('holds on thin data — in BOTH directions', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.4, cleanStreak: 2 }),
				evaluation: thinEvaluation(2),
			})
		);
		expect(decision.share).toBe(0.4);
		expect(decision.reason).toBe('holding');
		expect(decision.direction).toBe('hold');
		// Thin data HOLDS the streak; it neither extends nor resets it.
		expect(decision.cleanStreak).toBe(2);
	});

	it('holds when no evaluation could be produced at all', () => {
		const decision = nextShare(
			controllerInput({ mix: mixState({ share: 0.4, cleanStreak: 2 }), evaluation: null })
		);
		expect(decision.share).toBe(0.4);
		expect(decision.reason).toBe('holding');
		expect(decision.verdict).toBe('not_evaluated');
	});
});

describe('nextShare — ceilings and confidence', () => {
	it('holds while the clean streak is still building', () => {
		const decision = nextShare(
			controllerInput({ mix: mixState({ share: 0.1 }), evaluation: cleanEvaluation(1) })
		);
		expect(decision.share).toBe(0.1);
		expect(decision.reason).toBe('building_confidence');
		expect(decision.cleanStreak).toBe(2);
	});

	it('increases by the stream step once K_CLEAN is reached', () => {
		const decision = nextShare(
			controllerInput({ mix: mixState({ share: 0.1 }), evaluation: cleanEvaluation(2) })
		);
		expect(decision.share).toBe(0.15);
		expect(decision.reason).toBe('healthy');
		expect(decision.direction).toBe('increase');
	});

	it('holds a K_CLEAN-satisfied cell whose evaluation window is already counted', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.1, cleanStreak: 3, lastCountedAt: NOW - HOUR }),
				evaluation: cleanEvaluation(3),
			})
		);
		expect(decision.share).toBe(0.1);
		expect(decision.reason).toBe('window_open');
		expect(decision.direction).toBe('hold');
	});

	it('still pulls back to a lowered ceiling mid-window — retreats are never delayed', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.5, cleanStreak: 3, lastCountedAt: NOW - HOUR }),
				capacity: { kind: 'projected', warmingCapRemaining: 100, projectedVolume: 1_000 },
				evaluation: cleanEvaluation(3),
			})
		);
		expect(decision.share).toBe(0.08);
		expect(decision.reason).toBe('capacity_ceiling');
	});

	it('uses the transactional step for a transactional cell', () => {
		const decision = nextShare(
			controllerInput({
				cell: { stream: 'transactional', destinationProvider: 'gmail' },
				config: RAMP_STREAM_CONFIGS.transactional,
				mix: mixState({ share: 0.1 }),
			})
		);
		expect(decision.share).toBe(0.13);
		expect(decision.reason).toBe('healthy');
	});

	it('binds on remaining warming capacity, naming it', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.5 }),
				capacity: { kind: 'projected', warmingCapRemaining: 100, projectedVolume: 1_000 },
			})
		);
		// 100/1000 x SAFETY 0.8 = 0.08
		expect(decision.share).toBe(0.08);
		expect(decision.reason).toBe('capacity_ceiling');
		expect(decision.direction).toBe('decrease');
	});

	it('binds on the phase ceiling, naming it', () => {
		const decision = nextShare(
			controllerInput({ mix: mixState({ share: 0.25, phaseCeiling: 0.25 }) })
		);
		expect(decision.share).toBe(0.25);
		expect(decision.reason).toBe('phase_ceiling');
		expect(decision.direction).toBe('hold');
		expect(decision.ceiling).toBe(0.25);
	});

	it('never steps past the phase ceiling', () => {
		const decision = nextShare(
			controllerInput({ mix: mixState({ share: 0.23, phaseCeiling: 0.25 }) })
		);
		expect(decision.share).toBe(0.25);
		expect(decision.reason).toBe('healthy');
	});

	it('holds when the capacity projection is unusable rather than treating it as no limit', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.3 }),
				capacity: { kind: 'projected', warmingCapRemaining: Number.NaN, projectedVolume: 1_000 },
			})
		);
		expect(decision.share).toBe(0.3);
		expect(decision.reason).toBe('capacity_unknown');
	});

	it('carries the cell, the config and the clock through untouched', () => {
		const input = controllerInput({
			cell: GMAIL_CAMPAIGN,
			signals: CLEAR_SIGNALS,
			capacity: OPEN_CAPACITY,
		});
		const decision = nextShare(input);
		expect(decision.fromShare).toBe(0.02);
		expect(decision.phaseCeiling).toBe(1);
		expect(decision.verdict).toBe('pass');
	});
});
