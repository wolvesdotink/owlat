/**
 * PURITY (plan D15). The decision functions take data and return verdicts; the
 * cron is a thin shell that loads, calls and writes. Two ways of checking it:
 *
 *   1. STATICALLY — no module of the decision core (`delivery/ramp` and the
 *      signal sources in `delivery/signals`) may contain a clock, a random
 *      source, an environment read or a database handle. This is the check that
 *      keeps the property true as the core grows, and it is deliberately a
 *      source grep rather than a mock, because a mock only proves the paths a
 *      test happened to walk.
 *   2. BEHAVIOURALLY — identical inputs give identical outputs, arguments are
 *      not mutated, and shifting the injected clock (and nothing else) is what
 *      changes the verdict.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { referenceArmGateEvaluator } from '../gateEvaluation';
import { evaluateHardBounceGate } from '../gates';
import { RAMP_GATE_THRESHOLDS } from '../gateConfig';
import type { RampGateEvaluation, RampGateEvaluationInput } from '../gateTypes';
import { arm, describeEquipped, healthyInput, input, NOW } from './gateFixtures';

function evaluate(built: RampGateEvaluationInput): RampGateEvaluation {
	return referenceArmGateEvaluator.evaluate(built);
}

const rampDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// TWO ROOTS, because the decision core lives in two directories. `delivery/ramp`
// holds the gates and the fold; `delivery/signals` holds the sources P4.3
// re-homed out of it — the SNDS and Yahoo verdicts, and the registry both
// evaluators now fold. Enumerating only the first would have let a clock into
// exactly the modules this piece moved, so the roots are listed here and the
// FILES inside them are still enumerated, never hand-listed: a sixth measurement
// is covered the day it lands, which is the growth this check exists to survive.
const ROOTS: readonly { readonly label: string; readonly dir: string }[] = [
	{ label: 'ramp', dir: rampDir },
	{ label: 'signals', dir: join(rampDir, '..', 'signals') },
];

const MODULES: readonly { readonly name: string; readonly path: string }[] = ROOTS.flatMap(
	({ label, dir }) =>
		readdirSync(dir)
			.filter((file) => file.endsWith('.ts'))
			.sort()
			// The relative path is the test's name, so a failure says which of the two
			// `gates.ts`-shaped files it is talking about.
			.map((file) => ({ name: `${label}/${file}`, path: join(dir, file) }))
);

// Comments talk ABOUT clocks and databases; the code must not use them. Strip
// comments before grepping so the prose stays free and the check stays strict.
function sourceWithoutComments(path: string): string {
	return readFileSync(path, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
}

describe('the decision core is pure at the source level', () => {
	const forbidden: readonly { readonly name: string; readonly pattern: RegExp }[] = [
		{ name: 'a clock', pattern: /Date\.now|new Date\b|performance\.now/ },
		{ name: 'randomness', pattern: /Math\.random|crypto\./ },
		{ name: 'an environment read', pattern: /process\.env/ },
		{ name: 'a database handle', pattern: /\bctx\b|\bdb\./ },
		{ name: 'a Convex function wrapper', pattern: /\b(query|mutation|internalAction|action)\(/ },
	];

	it('found BOTH module directories — an empty list would silently check nothing', () => {
		const names = MODULES.map((module) => module.name);
		expect(names.length).toBeGreaterThan(0);
		// One landmark per root: a root that was renamed, moved or mistyped
		// enumerates to nothing, and nothing passes every pattern.
		expect(names).toContain('ramp/gates.ts');
		expect(names).toContain('signals/rampGateSources.ts');
	});

	for (const module of MODULES) {
		const source = sourceWithoutComments(module.path);
		for (const rule of forbidden) {
			it(`${module.name} contains no ${rule.name}`, () => {
				expect(source).not.toMatch(rule.pattern);
			});
		}
	}
});

describeEquipped('the decision core is pure behaviourally', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('gives identical output for identical input', () => {
		const built = healthyInput({ previousCleanStreak: 1 });
		expect(evaluate(built)).toEqual(evaluate(built));
	});

	it('does not mutate its input', () => {
		const built = healthyInput({ previousCleanStreak: 1 });
		const snapshot = structuredClone(built);
		evaluate(built);
		expect(built).toEqual(snapshot);
	});

	it('depends on the INJECTED clock and on nothing else', () => {
		const own = arm({ sent: 10_000, lastRecordedAt: NOW });
		const reference = arm({ sent: 10_000, lastRecordedAt: NOW });
		expect(evaluateHardBounceGate(input({ own, reference, now: NOW })).status).toBe('pass');
		expect(
			evaluateHardBounceGate(
				input({ own, reference, now: NOW + RAMP_GATE_THRESHOLDS.maxEvidenceAgeMs + 1 })
			).status
		).toBe('insufficient_data');
	});

	it('survives a 30-day SYSTEM-clock jump — nothing reads the system clock', () => {
		// A jump far past `maxEvidenceAgeMs`: a module that read `Date.now()` would
		// have to change its answer here, and 30 simulated days cost nothing where
		// a real sleep would be both slower and too small to prove anything.
		const built = healthyInput();
		const first = evaluate(built);
		vi.useFakeTimers();
		vi.setSystemTime(NOW + 30 * 24 * 60 * 60 * 1000);
		expect(evaluate(built)).toEqual(first);
	});
});
