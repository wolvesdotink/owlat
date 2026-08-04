/**
 * THE AIMD TABLE ON THE PACE MULTIPLIER (plan P3-7, D3, D9, D10).
 *
 * The share actuator's table, applied to the second dial: fail halves and
 * freezes, a halt goes straight to the floor, thin data holds in BOTH
 * directions, a clean streak increases, and M_MIN / M_MAX bound the whole thing.
 * If this suite and `rampControllerAimd.test.ts` ever disagree about what a
 * retreat costs, one of the two actuators has grown its own arithmetic — which
 * is the duplication `aimd.ts` exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import { nextPaceMultiplier } from '../paceActuator';
import { PACE_AIMD } from '../paceConfig';
import { RAMP_AIMD } from '../controllerConfig';
import {
	breachedEvaluation,
	cleanEvaluation,
	NOW,
	paceInput,
	paceState,
	thinEvaluation,
	UNEXERCISED,
} from './controllerFixtures';

describe('pace actuator — the AIMD table', () => {
	it('increases additively after K_CLEAN clean windows', () => {
		const decision = nextPaceMultiplier(paceInput());
		expect(decision.direction).toBe('increase');
		expect(decision.multiplier).toBeCloseTo(1 + PACE_AIMD.increaseStep, 5);
		expect(decision.reason).toBe('healthy');
	});

	it('holds while the clean streak is still building', () => {
		const decision = nextPaceMultiplier(paceInput({ evaluation: cleanEvaluation(0) }));
		expect(decision.direction).toBe('hold');
		expect(decision.reason).toBe('building_confidence');
	});

	it('halves and freezes the instant a gate breaches', () => {
		const decision = nextPaceMultiplier(
			paceInput({ evaluation: breachedEvaluation('hard_bounce') })
		);
		expect(decision.direction).toBe('decrease');
		expect(decision.multiplier).toBeCloseTo(0.5, 5);
		expect(decision.reason).toBe('hard_bounce');
		expect(decision.failedGate).toBe('hard_bounce');
		expect(decision.freeze?.origin).toBe('gate_breach');
		expect(decision.freeze?.until).toBe(NOW + RAMP_AIMD.cooldownBaseMs);
		expect(decision.freeze?.ladderMs).toBe(RAMP_AIMD.cooldownBaseMs);
	});

	it('sends a HALT straight to the floor rather than halving toward it', () => {
		const decision = nextPaceMultiplier(
			paceInput({
				pace: paceState({ multiplier: 1.4 }),
				evaluation: breachedEvaluation('deferral', { halt: true }),
			})
		);
		expect(decision.multiplier).toBe(PACE_AIMD.multiplierFloor);
	});

	it('never retreats below M_MIN — the trickle that keeps the cell measurable', () => {
		const decision = nextPaceMultiplier(
			paceInput({
				pace: paceState({ multiplier: PACE_AIMD.multiplierFloor }),
				evaluation: breachedEvaluation('complaint'),
			})
		);
		expect(decision.multiplier).toBe(PACE_AIMD.multiplierFloor);
		expect(decision.multiplier).toBeGreaterThan(0);
	});

	it('never advances past M_MAX; the published schedule bounds the cap from there', () => {
		const decision = nextPaceMultiplier(
			paceInput({ pace: paceState({ multiplier: PACE_AIMD.multiplierCeiling }) })
		);
		expect(decision.direction).toBe('hold');
		expect(decision.multiplier).toBe(PACE_AIMD.multiplierCeiling);
		expect(decision.reason).toBe('schedule_ceiling');
	});

	it('clamps an increase to M_MAX rather than stepping past it', () => {
		const decision = nextPaceMultiplier(
			paceInput({ pace: paceState({ multiplier: PACE_AIMD.multiplierCeiling - 0.05 }) })
		);
		expect(decision.multiplier).toBe(PACE_AIMD.multiplierCeiling);
	});

	it('HOLDS on thin data — never up, and never down either (D10)', () => {
		const decision = nextPaceMultiplier(paceInput({ evaluation: thinEvaluation(3) }));
		expect(decision.direction).toBe('hold');
		expect(decision.multiplier).toBe(1);
		expect(decision.reason).toBe('holding');
	});

	it('HOLDS when there is no evaluation at all', () => {
		const decision = nextPaceMultiplier(paceInput({ evaluation: null }));
		expect(decision.direction).toBe('hold');
		expect(decision.reason).toBe('holding');
	});

	it('a retreat is never rationed by the per-day guard or by thin utilisation', () => {
		// Both of the rules that BLOCK an increase sit below the breach rung, so a
		// breached gate halves the dial even on a day already counted and even with
		// a cap nobody exercised. Cheap to retreat, expensive to advance.
		const decision = nextPaceMultiplier(
			paceInput({
				pace: paceState({ lastEvaluatedUtcDay: '2027-01-15' }),
				utilisation: UNEXERCISED,
				evaluation: breachedEvaluation('hard_bounce'),
			})
		);
		expect(decision.direction).toBe('decrease');
		expect(decision.multiplier).toBeCloseTo(0.5, 5);
	});
});

describe('pace actuator — hard stops and degenerate input', () => {
	it('pins the dial in both directions while the kill switch is engaged', () => {
		const decision = nextPaceMultiplier(paceInput({ isKillSwitchEngaged: true }));
		expect(decision.direction).toBe('hold');
		expect(decision.reason).toBe('kill_switch');
		expect(decision.countedUtcDay).toBeUndefined();
	});

	it('never decides against a broken clock', () => {
		const decision = nextPaceMultiplier(paceInput({ now: Number.NaN }));
		expect(decision.reason).toBe('clock_unusable');
		expect(decision.freeze).toBeUndefined();
	});

	it('abuse status floors the dial without freezing it', () => {
		const decision = nextPaceMultiplier(
			paceInput({
				signals: { isSendingAllowed: false, isCircuitBreakerOpen: false, isPoolBlocklisted: false },
			})
		);
		expect(decision.multiplier).toBe(PACE_AIMD.multiplierFloor);
		expect(decision.freeze).toBeUndefined();
	});

	it('charges the breaker retreat ONCE per incident, not once per tick', () => {
		const first = nextPaceMultiplier(
			paceInput({
				signals: { isSendingAllowed: true, isCircuitBreakerOpen: true, isPoolBlocklisted: false },
			})
		);
		expect(first.multiplier).toBeCloseTo(0.5, 5);
		const second = nextPaceMultiplier(
			paceInput({
				pace: paceState({
					multiplier: first.multiplier,
					frozenUntil: first.freeze?.until,
					freezeReason: 'breaker',
				}),
				signals: { isSendingAllowed: true, isCircuitBreakerOpen: true, isPoolBlocklisted: false },
			})
		);
		expect(second.direction).toBe('hold');
		expect(second.multiplier).toBeCloseTo(0.5, 5);
	});

	it('a critical blocklist listing floors the dial and freezes for 24h', () => {
		const decision = nextPaceMultiplier(
			paceInput({
				signals: { isSendingAllowed: true, isCircuitBreakerOpen: false, isPoolBlocklisted: true },
			})
		);
		expect(decision.multiplier).toBe(PACE_AIMD.multiplierFloor);
		expect(decision.freeze?.origin).toBe('dnsbl');
		expect(decision.freeze?.until).toBe(NOW + RAMP_AIMD.blocklistFreezeMs);
	});

	it('holds at the clamped value when the stored multiplier is not one', () => {
		for (const stored of [Number.NaN, -4, 99]) {
			const decision = nextPaceMultiplier(paceInput({ pace: paceState({ multiplier: stored }) }));
			expect(decision.reason).toBe('multiplier_unreadable');
			expect(decision.multiplier).toBeGreaterThanOrEqual(PACE_AIMD.multiplierFloor);
			expect(decision.multiplier).toBeLessThanOrEqual(PACE_AIMD.multiplierCeiling);
		}
	});

	it('an unexpired freeze holds however clean the gates look', () => {
		const decision = nextPaceMultiplier(
			paceInput({ pace: paceState({ frozenUntil: NOW + 1_000, freezeReason: 'gate_breach' }) })
		);
		expect(decision.direction).toBe('hold');
		expect(decision.reason).toBe('frozen');
	});

	it('a freeze expiry no rung could have stamped holds under its own reason', () => {
		const decision = nextPaceMultiplier(
			paceInput({ pace: paceState({ frozenUntil: NOW + 400 * 24 * 60 * 60 * 1000 }) })
		);
		expect(decision.reason).toBe('freeze_unreadable');
		expect(decision.direction).toBe('hold');
	});
});
