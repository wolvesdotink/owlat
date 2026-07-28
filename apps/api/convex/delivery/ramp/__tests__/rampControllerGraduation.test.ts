/**
 * GRADUATION (plan D9): s = 1.0 held FOURTEEN days with every gate green pins
 * the cell, and the relay drops to priority_failover standby.
 *
 * Thirteen days does not. One non-green window resets the clock.
 *
 * The pin is REVOKED by a hard stop or a breached gate, and by nothing else. It
 * is deliberately NOT re-derived from the share, because the warming cap can
 * hold a graduated cell below 1.0 without the cell having failed anything — and
 * a pin that evaporated on the next tick would make it re-earn fourteen days
 * for a physical limit. That is a two-tick fact, so it is tested over two ticks.
 *
 * The pin is also NOT a shortcut. The graduation rung may hold a cell or pull it
 * back to a bound, never raise it: restoring a bounded pin is an increase like
 * any other and is paid for in K_CLEAN, one counted window and one +step.
 */

import { describe, expect, it } from 'vitest';
import { nextShare } from '../controller';
import { RAMP_AIMD } from '../controllerConfig';
import { describeRampDecision } from '../controllerNarrative';
import { isFallbackActiveForShare } from '@owlat/shared/deliverabilityRouting';
import type { RampCapacityInput } from '../controllerTypes';
import {
	breachedEvaluation,
	cleanEvaluation,
	controllerInput,
	DAY,
	GMAIL_CAMPAIGN,
	mixState,
	NOW,
	thinEvaluation,
} from './controllerFixtures';

const FOURTEEN_DAYS = 14 * DAY;

describe('graduation', () => {
	it('pins the cell after 14 green days at full share', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 1, cleanStreak: 40, greenSince: NOW - FOURTEEN_DAYS }),
				evaluation: cleanEvaluation(40),
			})
		);
		expect(decision.reason).toBe('graduated');
		expect(decision.share).toBe(1);
		expect(decision.graduatedAt).toBe(NOW);
		// The relay is standby by construction: a full share means no fallback.
		expect(isFallbackActiveForShare(decision.share)).toBe(false);
		// The share did not move, so `direction` cannot see this. The PIN is the
		// transition, and it is what carries the tick into the audit log.
		expect(decision.direction).toBe('hold');
		expect(decision.pinChange).toBe('awarded');
	});

	/**
	 * A PIN IS NOT RE-EARNED EVERY FOURTEEN DAYS.
	 *
	 * `isGraduationDue` is re-derived from `greenSince`, and every holding rung
	 * CLEARS `greenSince` — an unmeasured window is not evidence of health. For an
	 * hourly cron a thin window is the common case, so reading the pin off that
	 * clock alone made an already-pinned cell report `phase_ceiling` ("the cell is
	 * at its phase ceiling") for the next fortnight, while `graduatedAt` still sat
	 * on the row and nothing had been revoked.
	 */
	it('still reads GRADUATED on the clean tick after a thin window', () => {
		const graduatedAt = NOW - 20 * DAY;
		const thin = nextShare(
			controllerInput({
				mix: mixState({ share: 1, cleanStreak: 40, greenSince: NOW - 30 * DAY, graduatedAt }),
				evaluation: thinEvaluation(40),
			})
		);
		// Thin data holds the share and the streak, stops the graduation clock…
		expect(thin.reason).toBe('holding');
		expect(thin.greenSince).toBeUndefined();
		// …and revokes nothing: the pin is still on the row the cron writes back.
		expect(thin.graduatedAt).toBe(graduatedAt);
		expect(thin.pinChange).toBeUndefined();

		const clean = nextShare(
			controllerInput({
				mix: mixState({
					share: thin.share,
					cleanStreak: thin.cleanStreak,
					greenSince: thin.greenSince,
					graduatedAt: thin.graduatedAt,
					lastCountedAt: thin.countedAt,
				}),
				evaluation: cleanEvaluation(40),
				now: NOW + DAY,
			})
		);
		// The green clock restarted at `now`, so fourteen days are NOT due — and the
		// cell is nonetheless still pinned, so that is what the sentence says.
		expect(clean.share).toBe(1);
		expect(clean.reason).toBe('graduated');
		expect(clean.graduatedAt).toBe(graduatedAt);
		expect(clean.pinChange).toBeUndefined();
		expect(describeRampDecision(GMAIL_CAMPAIGN, clean)).toContain('standby');
	});

	it('does NOT pin at thirteen days', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 1, cleanStreak: 40, greenSince: NOW - 13 * DAY }),
				evaluation: cleanEvaluation(40),
			})
		);
		expect(decision.reason).not.toBe('graduated');
		expect(decision.graduatedAt).toBeUndefined();
		expect(decision.share).toBe(1);
		// Still green, still climbing nowhere: the phase ceiling is what binds.
		expect(decision.reason).toBe('phase_ceiling');
		expect(decision.greenSince).toBe(NOW - 13 * DAY);
	});

	it('is still bounded by the warming cap — the pin is not an exemption', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 1, cleanStreak: 40, greenSince: NOW - FOURTEEN_DAYS }),
				evaluation: cleanEvaluation(40),
				// Half the projected volume of headroom, times the 0.8 safety margin.
				capacity: { kind: 'projected', warmingCapRemaining: 500, projectedVolume: 1_000 },
			})
		);
		// A graduated cell is the cell carrying the most volume, so it is the LAST
		// one that should be exempt from the cap.
		expect(decision.share).toBe(0.4);
		expect(decision.ceiling).toBe(0.4);
		// The sentence names the ceiling, not a graduation move nobody made...
		expect(decision.reason).toBe('capacity_ceiling');
		// ...but the cell is still graduated: capacity is a physical limit, not a
		// gate the cell failed.
		expect(decision.graduatedAt).toBe(NOW);
	});

	it('never lets a capacity ceiling of ZERO switch a graduated cell off', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 1, cleanStreak: 40, greenSince: NOW - FOURTEEN_DAYS }),
				evaluation: cleanEvaluation(40),
				// No headroom left at all: the projection says the cap is spent.
				capacity: { kind: 'projected', warmingCapRemaining: 0, projectedVolume: 1_000 },
			})
		);
		// A capacity ceiling is not a breach, and only a gate failure or a hard stop
		// may take a cell to zero. The trickle is what lets it be re-measured.
		expect(decision.share).toBe(RAMP_AIMD.shareFloor);
		expect(decision.reason).toBe('capacity_ceiling');
		expect(decision.graduatedAt).toBe(NOW);
	});

	it('keeps the pin across a SECOND tick spent under the capacity bound', () => {
		const capacity: RampCapacityInput = {
			kind: 'projected',
			warmingCapRemaining: 500,
			projectedVolume: 1_000,
		};
		const first = nextShare(
			controllerInput({
				mix: mixState({ share: 1, cleanStreak: 40, greenSince: NOW - FOURTEEN_DAYS }),
				evaluation: cleanEvaluation(40),
				capacity,
			})
		);
		expect(first.share).toBe(0.4);
		expect(first.graduatedAt).toBe(NOW);

		// The cron writes the decision back and ticks again a day later. Reading the
		// pin off the share would lose it here, and the cell would have to climb
		// from 0.4 at +5pp and re-hold fourteen days.
		const second = nextShare(
			controllerInput({
				mix: mixState({
					share: first.share,
					cleanStreak: first.cleanStreak,
					greenSince: first.greenSince,
					graduatedAt: first.graduatedAt,
					lastCountedAt: first.countedAt,
				}),
				evaluation: cleanEvaluation(41),
				capacity,
				now: NOW + DAY,
			})
		);
		expect(second.share).toBe(0.4);
		expect(second.reason).toBe('graduated');
		expect(second.graduatedAt).toBe(NOW);
		expect(second.greenSince).toBe(NOW - FOURTEEN_DAYS);
	});

	it('restores a bounded pin one AIMD STEP at a time, keeping the pin as it climbs', () => {
		const bound = mixState({
			share: 0.4,
			cleanStreak: 41,
			greenSince: NOW - 20 * DAY,
			graduatedAt: NOW - 6 * DAY,
		});

		// A restore is an INCREASE, so it costs a counted window like any other.
		const tooSoon = nextShare(
			controllerInput({
				mix: { ...bound, lastCountedAt: NOW - 1_000 },
				evaluation: cleanEvaluation(41),
			})
		);
		expect(tooSoon.share).toBe(0.4);
		expect(tooSoon.reason).toBe('window_open');
		expect(tooSoon.graduatedAt).toBe(NOW - 6 * DAY);

		// ...and it costs a STEP. The graduation rung may hold or lower, never
		// raise: a pinned cell that the cap released does not leap back to 1.0 in
		// one evaluation, it pays +5pp per counted window like every other increase.
		const restored = nextShare(controllerInput({ mix: bound, evaluation: cleanEvaluation(41) }));
		expect(restored.share).toBe(0.45);
		expect(restored.reason).toBe('healthy');
		expect(restored.direction).toBe('increase');
		// The pin survives the climb — the cell never stopped being graduated.
		expect(restored.graduatedAt).toBe(NOW - 6 * DAY);
		expect(restored.greenSince).toBe(NOW - 20 * DAY);
	});

	it('re-pins at full share only when the step arithmetic finally gets there', () => {
		const graduatedAt = NOW - 6 * DAY;
		const bound = mixState({
			share: 0.96,
			cleanStreak: 41,
			greenSince: NOW - 20 * DAY,
			graduatedAt,
		});
		const stepped = nextShare(controllerInput({ mix: bound, evaluation: cleanEvaluation(41) }));
		expect(stepped.share).toBe(1);
		expect(stepped.reason).toBe('healthy');

		const pinned = nextShare(
			controllerInput({
				mix: mixState({
					share: stepped.share,
					cleanStreak: stepped.cleanStreak,
					greenSince: stepped.greenSince,
					graduatedAt: stepped.graduatedAt,
					lastCountedAt: stepped.countedAt,
				}),
				evaluation: cleanEvaluation(42),
				now: NOW + DAY,
			})
		);
		expect(pinned.share).toBe(1);
		expect(pinned.reason).toBe('graduated');
		expect(pinned.graduatedAt).toBe(graduatedAt);
	});

	it('does not claim the relay is on standby while a bounded pin sits below 1.0', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({
					share: 0.4,
					cleanStreak: 41,
					greenSince: NOW - 20 * DAY,
					graduatedAt: NOW - 6 * DAY,
				}),
				evaluation: cleanEvaluation(41),
				// Exactly the bound the cell already sits at: hold, reason `graduated`.
				capacity: { kind: 'projected', warmingCapRemaining: 500, projectedVolume: 1_000 },
			})
		);
		expect(decision.share).toBe(0.4);
		expect(decision.reason).toBe('graduated');

		const sentence = describeRampDecision(GMAIL_CAMPAIGN, decision);
		expect(sentence).toContain('40%');
		expect(sentence).not.toContain('100%');
		expect(sentence).not.toContain('standby');
		// The relay is demonstrably still carrying the rest of this cell.
		expect(isFallbackActiveForShare(decision.share)).toBe(true);
	});

	it('keeps an existing graduation instant rather than restamping it', () => {
		const graduatedAt = NOW - 30 * DAY;
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 1, cleanStreak: 40, greenSince: NOW - 40 * DAY, graduatedAt }),
				evaluation: cleanEvaluation(40),
			})
		);
		expect(decision.reason).toBe('graduated');
		expect(decision.graduatedAt).toBe(graduatedAt);
	});

	it('resets the clock on ONE non-green window, and un-pins the cell', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({
					share: 1,
					cleanStreak: 40,
					greenSince: NOW - 40 * DAY,
					graduatedAt: NOW - 20 * DAY,
				}),
				evaluation: breachedEvaluation('complaint', { previousCleanStreak: 40 }),
			})
		);
		expect(decision.share).toBe(0.5);
		expect(decision.greenSince).toBeUndefined();
		expect(decision.graduatedAt).toBeUndefined();
	});

	it('stops the clock on an UNMEASURED window without punishing the cell', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 1, cleanStreak: 40, greenSince: NOW - 13 * DAY }),
				evaluation: thinEvaluation(40),
			})
		);
		expect(decision.share).toBe(1);
		expect(decision.reason).toBe('holding');
		// Not green, so not counting toward a pin — but the streak is untouched.
		expect(decision.greenSince).toBeUndefined();
		expect(decision.cleanStreak).toBe(40);
	});

	it('never starts the clock below full share', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 0.8, cleanStreak: 40, greenSince: NOW - 40 * DAY }),
			})
		);
		expect(decision.greenSince).toBeUndefined();
		expect(decision.reason).toBe('healthy');
	});

	it('starts the clock the first window a cell is green at full share', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 1, cleanStreak: 40 }),
				evaluation: cleanEvaluation(40),
			})
		);
		expect(decision.greenSince).toBe(NOW);
		expect(decision.reason).toBe('phase_ceiling');
	});

	// D17: a lone seed tripwire is SUSPECT and the controller explicitly declines
	// to act on it. Revoking the pin on that same evidence would be acting on it —
	// and an expensive action at that, since the next clean window restarts the
	// hold clock from zero and the cell would owe another fourteen days.
	it('an UNCORROBORATED tripwire holds the cell AND keeps its graduation pin', () => {
		const graduatedAt = NOW - 20 * DAY;
		const decision = nextShare(
			controllerInput({
				mix: mixState({
					share: 1,
					cleanStreak: 40,
					greenSince: NOW - 40 * DAY,
					graduatedAt,
				}),
				evaluation: breachedEvaluation('seed_placement', { previousCleanStreak: 40 }),
			})
		);
		expect(decision.reason).toBe('awaiting_corroboration');
		expect(decision.share).toBe(1);
		expect(decision.graduatedAt).toBe(graduatedAt);
		// The window is still not green, so the hold clock does reset.
		expect(decision.greenSince).toBeUndefined();
	});

	it('but a gate the controller DOES act on revokes the pin', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({
					share: 1,
					cleanStreak: 40,
					greenSince: NOW - 40 * DAY,
					graduatedAt: NOW - 20 * DAY,
				}),
				evaluation: breachedEvaluation('deferral', { previousCleanStreak: 40 }),
			})
		);
		expect(decision.reason).toBe('deferral');
		expect(decision.share).toBe(0.5);
		expect(decision.graduatedAt).toBeUndefined();
	});

	it('a hard stop un-pins a graduated cell', () => {
		const decision = nextShare(
			controllerInput({
				mix: mixState({ share: 1, greenSince: NOW - 40 * DAY, graduatedAt: NOW - 20 * DAY }),
				signals: { isSendingAllowed: true, isCircuitBreakerOpen: true, isPoolBlocklisted: false },
			})
		);
		expect(decision.share).toBe(RAMP_AIMD.decreaseFactor);
		expect(decision.graduatedAt).toBeUndefined();
		expect(decision.reason).toBe('breaker');
		// Losing the pin is the other half of the transition the audit log follows.
		expect(decision.pinChange).toBe('revoked');
	});
});
