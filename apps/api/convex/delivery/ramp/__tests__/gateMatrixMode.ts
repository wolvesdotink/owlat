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
 * "This process IS a matrix leg." Set by `scripts/test-ramp.sh` (which the
 * `ramp-gate-matrix` job runs) and by nothing else — not by CI, not by the
 * sharded `test-api` job, not by turbo.
 *
 * It exists so {@link rampGateMatrixMode} can tell "the matrix ran and lost its
 * mode" from "something else ran this suite". `CI` cannot: every job in the
 * workflow has `CI=true`, and `test-api` runs the whole convex/ glob — this
 * module included — with no mode, so keying the throw on `CI` fails three shards
 * on every PR while proving nothing about the matrix.
 */
export const RAMP_GATE_MATRIX_SENTINEL_ENV = 'OWLAT_RAMP_GATE_MATRIX';

/**
 * Which leg of the matrix this process is. Defaults to `reference_arm` so a
 * developer running `vitest` locally — and the sharded api job, which runs this
 * suite as part of the whole convex/ glob — gets the fully-equipped
 * configuration.
 *
 * INSIDE THE MATRIX THERE IS NO DEFAULT. The job sets the sentinel alongside the
 * mode, so a sentinel with an absent or empty mode means the env plumbing broke
 * — a renamed matrix key, a lost `env:` block — and defaulting would run the
 * equipped leg twice and report two green checks for a degraded path nobody
 * exercised. A missing value is therefore as fatal as an unrecognised one: a
 * matrix that silently collapses to one leg is worse than no matrix.
 */
export function rampGateMatrixMode(): RampGateMatrixMode {
	const raw = process.env[RAMP_GATE_MATRIX_ENV];
	if (raw === undefined || raw === '') {
		const sentinel = process.env[RAMP_GATE_MATRIX_SENTINEL_ENV];
		if (sentinel !== undefined && sentinel !== '') {
			throw new Error(
				`${RAMP_GATE_MATRIX_SENTINEL_ENV} is set but ${RAMP_GATE_MATRIX_ENV} is not — the ` +
					'matrix must name its leg, never default to the equipped one. Check the ' +
					'`ramp-gate-matrix` job in .github/workflows/test.yml and scripts/test-ramp.sh.'
			);
		}
		return 'reference_arm';
	}
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
