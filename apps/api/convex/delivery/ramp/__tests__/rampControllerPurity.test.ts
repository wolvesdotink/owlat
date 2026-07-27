/**
 * THE DECISION FUNCTIONS ARE PURE (plan D15).
 *
 * `nextShare` takes data and returns a verdict. The clock is a parameter. If it
 * ever reads `Date.now()`, a database or the environment, it stops being
 * exhaustively testable against fixtures — and the fixtures are the only reason
 * anyone can trust a controller that halves production traffic unattended.
 *
 * Enforced two ways: behaviourally (the same input yields the same output with
 * the system clock moved by a year, and no output depends on wall time), and
 * textually (the module source contains no clock, database or env reference).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capacityCeiling, nextCooldownMs, nextShare } from '../controller';
import { RAMP_AIMD } from '../controllerConfig';
import { breachedEvaluation, controllerInput, DAY, mixState, NOW } from './controllerFixtures';

const PURE_MODULES = ['../controller.ts', '../controllerConfig.ts', '../controllerNarrative.ts'];

/**
 * The module's CODE, with comments removed — these modules document the rule
 * they obey ("no `Date.now()`"), and a guard that cannot tell the prohibition
 * from the violation is a guard that fires on its own documentation.
 */
function sourceOf(relativePath: string): string {
	return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1');
}

afterEach(() => {
	vi.useRealTimers();
});

describe('no ambient dependencies in the source', () => {
	for (const modulePath of PURE_MODULES) {
		it(`${modulePath} reads no clock, database or environment`, () => {
			const source = sourceOf(modulePath);
			expect(source).not.toMatch(/Date\.now\(/);
			expect(source).not.toMatch(/new Date\(/);
			expect(source).not.toMatch(/performance\.now\(/);
			expect(source).not.toMatch(/process\.env/);
			expect(source).not.toMatch(/Math\.random\(/);
			expect(source).not.toMatch(/\bctx\b/);
			expect(source).not.toMatch(/_generated/);
		});
	}
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
		expect(capacityCeiling({ warmingCapRemaining: 80, projectedVolume: 100 })).toBe(
			capacityCeiling({ warmingCapRemaining: 80, projectedVolume: 100 })
		);
	});
});
