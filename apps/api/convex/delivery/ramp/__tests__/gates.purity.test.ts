/**
 * PURITY (plan D15). The decision functions take data and return verdicts; the
 * cron is a thin shell that loads, calls and writes. Two ways of checking it:
 *
 *   1. STATICALLY — the module source may not contain a clock, a random source,
 *      an environment read or a database handle. This is the check that keeps
 *      the property true as the module grows, and it is deliberately a source
 *      grep rather than a mock, because a mock only proves the paths a test
 *      happened to walk.
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

const moduleDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// ENUMERATED, never hand-listed: a fifth file added to delivery/ramp/ (P1-5's
// engagement gate, P1-7's trailing baseline) is covered the day it lands, which
// is the growth this source-level check exists to survive.
const MODULES: readonly string[] = readdirSync(moduleDir)
	.filter((file) => file.endsWith('.ts'))
	.sort();

// Comments talk ABOUT clocks and databases; the code must not use them. Strip
// comments before grepping so the prose stays free and the check stays strict.
function sourceWithoutComments(file: string): string {
	return readFileSync(join(moduleDir, file), 'utf8')
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

	it('found the module directory — an empty list would silently check nothing', () => {
		expect(MODULES.length).toBeGreaterThan(0);
		expect(MODULES).toContain('gates.ts');
	});

	for (const file of MODULES) {
		const source = sourceWithoutComments(file);
		for (const rule of forbidden) {
			it(`${file} contains no ${rule.name}`, () => {
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
