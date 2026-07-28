/**
 * THE DECISION FUNCTIONS ARE PURE (plan D15).
 *
 * `nextShare` takes data and returns a verdict. The clock is a parameter. If it
 * ever reads `Date.now()`, a database or the environment, it stops being
 * exhaustively testable against fixtures — and the fixtures are the only reason
 * anyone can trust a controller that halves production traffic unattended.
 *
 * Enforced BEHAVIOURALLY here: the same input yields the same output with the
 * system clock moved by a year, no output depends on wall time, and every
 * instant the decision emits is derived from the `now` parameter.
 *
 * The SOURCE-LEVEL half of the guarantee lives in `gates.purity.test.ts`, which
 * ENUMERATES `delivery/ramp/*.ts` and bans a strictly larger set (a clock,
 * randomness, an env read, a database handle and a Convex function wrapper).
 * That guard already covers every module this suite exercises, and a second
 * hand-written module list beside it is precisely the drift the enumerating
 * guard exists to prevent — so there is deliberately no second copy here.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { capacityCeiling, nextCooldownMs, nextShare } from '../controller';
import { RAMP_AIMD } from '../controllerConfig';
import { breachedEvaluation, controllerInput, DAY, mixState, NOW } from './controllerFixtures';

afterEach(() => {
	vi.useRealTimers();
});

describe('behavioural purity', () => {
	it('produces the identical decision with the system clock a year away', () => {
		const input = controllerInput({
			mix: mixState({ share: 0.4 }),
			evaluation: breachedEvaluation('complaint'),
		});
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
		const first = nextShare(input);
		vi.setSystemTime(new Date('2031-06-30T12:00:00Z'));
		const second = nextShare(input);
		expect(second).toStrictEqual(first);
	});

	it('is deterministic across repeated calls with the same input', () => {
		const input = controllerInput({ mix: mixState({ share: 0.31 }) });
		const results = Array.from({ length: 25 }, () => nextShare(input));
		for (const result of results) expect(result).toStrictEqual(results[0]);
	});

	it('does not mutate its input', () => {
		const input = controllerInput({ mix: mixState({ share: 0.4 }) });
		const before = JSON.parse(JSON.stringify(input)) as unknown;
		nextShare(input);
		expect(JSON.parse(JSON.stringify(input))).toStrictEqual(before);
	});

	it('derives every instant it emits from the `now` PARAMETER', () => {
		const at = NOW + 3 * DAY;
		const decision = nextShare(
			controllerInput({
				now: at,
				mix: mixState({ share: 0.4 }),
				evaluation: breachedEvaluation('complaint', { now: at }),
			})
		);
		expect(decision.cooldownMs).toBe(RAMP_AIMD.cooldownBaseMs);
		expect(decision.frozenUntil).toBe(at + RAMP_AIMD.cooldownBaseMs);
	});

	it('the helpers are pure too', () => {
		expect(nextCooldownMs(mixState(), NOW)).toBe(nextCooldownMs(mixState(), NOW));
		expect(
			capacityCeiling({ kind: 'projected', warmingCapRemaining: 80, projectedVolume: 100 })
		).toBe(capacityCeiling({ kind: 'projected', warmingCapRemaining: 80, projectedVolume: 100 }));
	});
});
