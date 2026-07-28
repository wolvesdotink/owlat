/**
 * THE STANDALONE MATRIX (plan D3's "the degraded path must not rot").
 *
 * The whole gate suite runs TWICE in CI — once with a reference arm and external
 * data present, once fully standalone — and this module is what tells a suite
 * which configuration it is in. See the `ramp-gate-matrix` job in
 * `.github/workflows/test.yml`.
 *
 * WHY A CI MATRIX AND NOT JUST MORE TEST CASES. Test cases prove the standalone
 * gates work when someone remembers to write standalone test cases. The matrix
 * proves something stronger and more durable: that the SUITE ITSELF, whatever it
 * grows into, still passes with every external input removed. A future piece that
 * quietly makes a reference arm load-bearing — for a threshold, for a default, for
 * a fixture everything else builds on — fails the standalone leg on the very PR
 * that introduces it, which is the only moment anyone can cheaply fix it.
 *
 * NOT PRODUCTION CODE. This lives under `__tests__` and reads `process.env`
 * directly on purpose: it configures a test run, not a deployment, and it must
 * never become something the ramp itself consults.
 */

import { referenceArmGateEvaluator, trailingBaselineGateEvaluator } from '../gateEvaluation';
import type { RampGateEvaluator } from '../gateTypes';

export type RampGateMatrixMode = 'reference_arm' | 'standalone';

export const RAMP_GATE_MATRIX_ENV = 'OWLAT_RAMP_GATE_MATRIX_MODE';

/**
 * Which leg of the matrix this process is. Defaults to `reference_arm` so a
 * developer running `vitest` locally gets the fully-equipped configuration; CI
 * runs the standalone leg explicitly.
 *
 * An unrecognised value FAILS rather than falling back: a typo in the workflow
 * that silently ran the reference leg twice would leave the degraded path
 * untested while reporting two green checks, which is worse than no matrix.
 */
export function rampGateMatrixMode(): RampGateMatrixMode {
	const raw = process.env[RAMP_GATE_MATRIX_ENV];
	if (raw === undefined || raw === '') return 'reference_arm';
	if (raw === 'reference_arm' || raw === 'standalone') return raw;
	throw new Error(`${RAMP_GATE_MATRIX_ENV} must be "reference_arm" or "standalone", got "${raw}"`);
}

export function matrixEvaluator(mode: RampGateMatrixMode): RampGateEvaluator {
	return mode === 'standalone' ? trailingBaselineGateEvaluator : referenceArmGateEvaluator;
}

/**
 * Whether the current leg is allowed ANY external input at all.
 *
 * `gateFixtures` reads this on the way in: in the standalone leg every fixture
 * builder REFUSES a reference arm or a reference seed sweep rather than quietly
 * accepting one, so the leg cannot be handed the very thing it exists to prove we
 * do not need — however far from this file the fixture was written.
 */
export function externalDataAllowed(mode: RampGateMatrixMode): boolean {
	return mode === 'reference_arm';
}
