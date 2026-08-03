/**
 * THE COOLDOWN LADDER (plan D9): 6h, DOUBLING on a repeat within 24h, capped at
 * 48h — the shape of the shipped MTA circuit breaker, so an operator has one
 * back-off model to hold in their head rather than two.
 *
 * AND EVERY STATE HERE IS ONE THE CONTROLLER CAN ACTUALLY BE IN. A ladder freeze
 * lasts exactly its own rung and the `frozen` rung refuses to evaluate a cell
 * while it runs, so a fixture whose freeze is STILL RUNNING while a gate breaches
 * describes a tick that cannot happen — and the suite that pinned the doubling
 * rule from such a fixture reported a ladder the production controller could
 * never climb. The repeat window is measured from the freeze's EXPIRY for exactly
 * that reason, and the walk below is the property that failed before it was:
 * breaching at the earliest instant each freeze allows must reach the 48h cap.
 *
 * And the property the ladder exists for: while a cell is frozen it does not
 * move, however good its gates look.
 */

import { describe, expect, it } from 'vitest';
import { nextShare } from '../controller';
import { nextCooldownMs, RAMP_AIMD } from '../controllerConfig';
import { nextPaceMultiplier } from '../paceActuator';
import {
	breachedEvaluation,
	cleanEvaluation,
	controllerInput,
	DAY,
	HOUR,
	mixState,
	NOW,
	paceInput,
	paceState,
} from './controllerFixtures';

/**
 * A cell whose LAST LADDER FREEZE of `rung` ended `sinceExpiry` ago — the only
 * shape a breaching cell can have, since it must have outlived its own freeze to
 * be evaluated at all.
 */
function afterFreeze(rung: number, sinceExpiry: number) {
	return mixState({ cooldownMs: rung, freezeStartedAt: NOW - rung - sinceExpiry });
}

describe('nextCooldownMs', () => {
	it('starts at 6h for a cell that has never been frozen', () => {
		expect(nextCooldownMs(mixState(), NOW)).toBe(6 * HOUR);
	});

	it('doubles on a repeat inside 24h of the previous freeze ENDING', () => {
		expect(nextCooldownMs(afterFreeze(6 * HOUR, 12 * HOUR), NOW)).toBe(12 * HOUR);
		expect(nextCooldownMs(afterFreeze(12 * HOUR, 12 * HOUR), NOW)).toBe(24 * HOUR);
		expect(nextCooldownMs(afterFreeze(24 * HOUR, 12 * HOUR), NOW)).toBe(48 * HOUR);
	});

	// THE ANCHOR, ALONE. A cell released an hour ago is a repeat however long the
	// freeze it just served was — measured from the START, a 24h rung would have
	// been forgiven by the clock the cell spent frozen and could never double.
	it('counts the frozen hours as served, not as clean running time', () => {
		expect(nextCooldownMs(afterFreeze(24 * HOUR, HOUR), NOW)).toBe(48 * HOUR);
		expect(
			nextCooldownMs(mixState({ cooldownMs: 24 * HOUR, freezeStartedAt: NOW - 25 * HOUR }), NOW)
		).toBe(48 * HOUR);
	});

	it('caps at 48h however many repeats accumulate', () => {
		expect(nextCooldownMs(afterFreeze(48 * HOUR, HOUR), NOW)).toBe(48 * HOUR);
	});

	// A rung no rung of this controller can stamp is read AS the cap, on BOTH
	// sides of the rule: it cannot double past 48h, and it cannot date an expiry
	// further out than a real freeze could have run to. Without the second half a
	// fabricated 96h rung would make a cell that has been clean for two days look
	// like one released moments ago.
	it('reads a stored rung above the cap as the cap, on both sides of the rule', () => {
		// Started 60h ago: read as the cap, the freeze ended 12h ago — a repeat.
		expect(
			nextCooldownMs(mixState({ cooldownMs: 96 * HOUR, freezeStartedAt: NOW - 60 * HOUR }), NOW)
		).toBe(RAMP_AIMD.cooldownMaxMs);
		// Started 96h ago: a real 48h freeze would have ended 48h ago, so the cell
		// has run clean for two days and the ladder starts again.
		expect(
			nextCooldownMs(mixState({ cooldownMs: 96 * HOUR, freezeStartedAt: NOW - 96 * HOUR }), NOW)
		).toBe(6 * HOUR);
	});

	it('restarts at the base once 24h of clean running has passed', () => {
		expect(nextCooldownMs(afterFreeze(24 * HOUR, 24 * HOUR), NOW)).toBe(6 * HOUR);
		expect(nextCooldownMs(afterFreeze(6 * HOUR, DAY + 1), NOW)).toBe(6 * HOUR);
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

/**
 * THE LADDER IS REACHABLE — the regression this anchor exists for.
 *
 * Each breach lands at the earliest instant its predecessor's freeze allows (the
 * tick the freeze expires), which is the fastest a real cell can possibly
 * re-breach. Every rung of the published ladder must be reachable that way, or
 * the 48h cap is a constant nothing can produce.
 */
describe('the published ladder is reachable from real ticks', () => {
	function breachAt(at: number, previous: { cooldownMs?: number; freezeStartedAt?: number }) {
		return nextShare(
			controllerInput({
				now: at,
				mix: mixState({ share: 0.4, ...previous }),
				evaluation: breachedEvaluation('complaint', { now: at }),
			})
		);
	}

	it('climbs 6h, 12h, 24h, 48h on breaches at the earliest permitted instant', () => {
		const rungs: number[] = [];
		let at = NOW;
		let previous: { cooldownMs?: number; freezeStartedAt?: number } = {};
		for (let step = 0; step < 4; step += 1) {
			const decision = breachAt(at, previous);
			const ladderMs = decision.freeze?.ladderMs;
			expect(ladderMs).toBeDefined();
			rungs.push(ladderMs ?? 0);
			// The next breach can only happen once THIS freeze has expired, and the
			// row carries the rung and the anchor the shell just stamped.
			previous = { cooldownMs: ladderMs, freezeStartedAt: at };
			at = decision.freeze?.until ?? at;
		}
		expect(rungs).toEqual([6 * HOUR, 12 * HOUR, 24 * HOUR, RAMP_AIMD.cooldownMaxMs]);
	});

	it('starts again at the base for a cell that ran a clean day after its release', () => {
		const first = breachAt(NOW, {});
		const releasedAt = first.freeze?.until ?? NOW;
		const second = breachAt(releasedAt + DAY, {
			cooldownMs: first.freeze?.ladderMs,
			freezeStartedAt: NOW,
		});
		expect(second.freeze?.ladderMs).toBe(RAMP_AIMD.cooldownBaseMs);
	});
});

/**
 * THE SAME LADDER ON THE SECOND DIAL. Both actuators climb one ladder through one
 * helper (plan D3), so the pace dial's rungs are the share dial's rungs — if this
 * suite and the walk above ever disagree, one actuator has grown its own penalty.
 */
describe('the pace actuator climbs the same ladder', () => {
	function paceBreachAt(at: number, previous: { cooldownMs?: number; freezeStartedAt?: number }) {
		return nextPaceMultiplier(
			paceInput({
				now: at,
				pace: paceState(previous),
				evaluation: breachedEvaluation('complaint', { now: at }),
			})
		);
	}

	it('reaches the 48h cap on breaches at the earliest permitted instant', () => {
		const rungs: number[] = [];
		let at = NOW;
		let previous: { cooldownMs?: number; freezeStartedAt?: number } = {};
		for (let step = 0; step < 4; step += 1) {
			const decision = paceBreachAt(at, previous);
			const ladderMs = decision.freeze?.ladderMs;
			expect(ladderMs).toBeDefined();
			rungs.push(ladderMs ?? 0);
			previous = { cooldownMs: ladderMs, freezeStartedAt: at };
			at = decision.freeze?.until ?? at;
		}
		expect(rungs).toEqual([6 * HOUR, 12 * HOUR, 24 * HOUR, RAMP_AIMD.cooldownMaxMs]);
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
	// second breach is 31h after the first — 25h after that 6h cooldown ended —
	// and starts again at the base, even though the cell was frozen for
	// infrastructure reasons an hour ago.
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
