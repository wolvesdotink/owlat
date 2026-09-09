/**
 * PURITY (plan D15). The decision functions take data and return verdicts; the
 * cron is a thin shell that loads, calls and writes. The static half — no module
 * of the decision core contains a clock, a random source, an environment read or
 * a database handle — is `scripts/check-ramp-purity.sh` (part of `bun run lint`).
 * This is the behavioural half: identical inputs give identical outputs,
 * arguments are not mutated, and shifting the injected clock (and nothing else)
 * is what changes the verdict.
 */

import { afterEach, expect, it, vi } from 'vitest';
import { referenceArmGateEvaluator } from '../gateEvaluation';
import { evaluateHardBounceGate } from '../gates';
import { RAMP_GATE_THRESHOLDS } from '../gateConfig';
import type { RampGateEvaluation, RampGateEvaluationInput } from '../gateTypes';
import { arm, describeEquipped, healthyInput, input, NOW } from './gateFixtures';

function evaluate(built: RampGateEvaluationInput): RampGateEvaluation {
	return referenceArmGateEvaluator.evaluate(built);
}

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
