/**
 * THE MATRIX PROOF (plan D2, D3).
 *
 * Two things are asserted here that nothing else can assert:
 *
 *  1. THE WORKFLOW REALLY RUNS BOTH LEGS. The acceptance criterion is a CI matrix,
 *     and a matrix that was renamed, dropped in a merge or never wired to the
 *     required status check is indistinguishable from one that never existed. So
 *     the workflow file itself is read and checked.
 *  2. THE STANDALONE LEG IS REALLY STANDALONE. A leg that is silently handed a
 *     reference arm reports green while proving nothing — the exact failure mode
 *     the matrix exists to prevent. So the leg asserts on its own inputs.
 *
 * Everything below runs in BOTH legs; the assertions branch on the mode rather
 * than the suite being skipped, so neither leg is a no-op.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	RAMP_GATE_MATRIX_ENV,
	RAMP_GATE_MATRIX_SENTINEL_ENV,
	externalDataAllowed,
	matrixEvaluator,
	rampGateMatrixMode,
} from './gateMatrixMode';
import {
	EXTERNAL_DATA_ALLOWED,
	arm,
	healthyInput,
	input,
	matrixInput,
	seeds,
	standaloneInput,
} from './gateFixtures';

const MODE = rampGateMatrixMode();
const EVALUATOR = matrixEvaluator(MODE);

const WORKFLOW = readFileSync(
	fileURLToPath(new URL('../../../../../../.github/workflows/test.yml', import.meta.url)),
	'utf8'
);
// The matrix job delegates to this script (also `bun run test:ramp` locally), so
// the sentinel, the mode and the globs live there and the workflow only names
// the leg.
const RAMP_SCRIPT = readFileSync(
	fileURLToPath(new URL('../../../../scripts/test-ramp.sh', import.meta.url)),
	'utf8'
);

describe('the CI matrix exists and runs both configurations', () => {
	it('declares both legs', () => {
		expect(WORKFLOW).toContain('ramp-gate-matrix');
		expect(WORKFLOW).toContain('mode: [reference_arm, standalone]');
	});

	it('passes the mode through the environment variable this suite reads', () => {
		expect(WORKFLOW).toContain('bun run test:ramp ${{ matrix.mode }}');
		expect(RAMP_SCRIPT).toContain(`${RAMP_GATE_MATRIX_ENV}="$mode"`);
	});

	it('sets the sentinel that makes a missing mode fatal, in that job only', () => {
		// The sentinel is what distinguishes "the matrix lost its mode" from "some
		// other job imported this file"; if only the mode survives a future edit,
		// the missing-mode case degrades to a silent default again. The script is
		// the only thing that sets it, and only the matrix job runs the script.
		expect(RAMP_SCRIPT).toContain(`${RAMP_GATE_MATRIX_SENTINEL_ENV}=1 `);
		expect(WORKFLOW).not.toMatch(new RegExp(`^\\s+${RAMP_GATE_MATRIX_SENTINEL_ENV}:`, 'm'));
		expect(WORKFLOW.match(/run: bun run test:ramp/g)).toHaveLength(1);
	});

	it('runs the signal registry in both legs, not just the ramp directory', () => {
		// The registry declares WHICH measurements each arm evaluates (seams plan
		// D9), so a leg that runs `convex/delivery/ramp` alone still folds the
		// standalone evaluators but never checks that they are the ones registered
		// for a deployment with no reference transport. Narrowing the glob back is
		// a one-word edit, and this is what makes that edit fail on its own PR.
		expect(RAMP_SCRIPT).toContain('vitest run convex/delivery/ramp convex/delivery/signals');
	});

	it('is wired into the required status check, not left dangling', () => {
		const summaryNeeds = WORKFLOW.slice(WORKFLOW.indexOf('test-summary:'));
		expect(summaryNeeds).toContain('ramp-gate-matrix');
	});
});

describe(`the ${MODE} leg`, () => {
	it('selects the evaluator its name promises', () => {
		expect(EVALUATOR.kind).toBe(MODE === 'standalone' ? 'trailing_baseline' : 'reference_arm');
	});

	it('is never silently handed a reference arm', () => {
		// The load-bearing assertion of the whole matrix: hand the builder a
		// reference arm on purpose and prove the standalone leg refuses it.
		const built = matrixInput(MODE, {
			reference: arm({ sent: 10_000, hardBounced: 10 }),
			referenceSeeds: seeds(20, 0),
		});
		if (externalDataAllowed(MODE)) {
			expect(built.reference).not.toBeNull();
		} else {
			expect(built.reference).toBeNull();
			expect(built.referenceSeeds ?? null).toBeNull();
		}
	});

	it('evaluates a healthy cell to a clean window with NO external account required', () => {
		const evaluation = EVALUATOR.evaluate(matrixInput(MODE, { previousCleanStreak: 1 }));
		expect(evaluation.verdict).toBe('pass');
		expect(evaluation.increaseEvidence).toBe(true);
		expect(evaluation.cleanStreak).toBe(2);
	});

	it('still retreats on a real failure', () => {
		const evaluation = EVALUATOR.evaluate(
			matrixInput(MODE, { own: arm({ sent: 10_000, hardBounced: 500 }) })
		);
		expect(evaluation.verdict).toBe('fail');
		expect(evaluation.failedGate).toBe('hard_bounce');
	});

	it('reports a confidence level the UI can render', () => {
		const evaluation = EVALUATOR.evaluate(matrixInput(MODE));
		expect(['high', 'medium', 'low']).toContain(evaluation.measuredConfidence);
	});

	it('makes the mode load-bearing for EVERY fixture, not just this suite', () => {
		// The whole point of the second leg (plan D3). The builders every suite in
		// this directory uses consult the mode themselves, so a case anywhere that
		// reaches for a reference arm to make something pass fails the standalone
		// leg — rather than rebuilding the same two-armed cell in both legs and
		// proving nothing.
		expect(EXTERNAL_DATA_ALLOWED).toBe(MODE === 'reference_arm');
		const withReference = () => input({ own: arm({ sent: 10_000 }), reference: arm({ sent: 10 }) });
		const withReferenceSeeds = () =>
			input({ own: arm({ sent: 10_000 }), referenceSeeds: seeds(20, 0) });
		if (EXTERNAL_DATA_ALLOWED) {
			expect(withReference().reference).not.toBeNull();
			expect(withReferenceSeeds().referenceSeeds).not.toBeNull();
			expect(healthyInput().reference).not.toBeNull();
		} else {
			expect(withReference).toThrow(/reference arm/);
			expect(withReferenceSeeds).toThrow(/reference seed sweep/);
			expect(healthyInput).toThrow(/REFERENCE-ARM cell/);
			// …and the standalone builder keeps working with none of it.
			expect(standaloneInput().reference).toBeNull();
		}
	});

	it('rejects an unrecognised mode rather than falling back to the equipped one', () => {
		withEnv({ [RAMP_GATE_MATRIX_ENV]: 'not_a_mode' }, () => {
			expect(() => rampGateMatrixMode()).toThrow(RAMP_GATE_MATRIX_ENV);
		});
	});

	it('rejects a MISSING mode inside the matrix, where broken plumbing looks like a default', () => {
		// The unrecognised-value case above only catches a typo. An env var that
		// never arrived — a renamed matrix key, a lost `env:` block — arrives as
		// undefined, and defaulting it would run the equipped leg twice and report
		// two green checks for a degraded path nobody exercised.
		withEnv({ [RAMP_GATE_MATRIX_ENV]: undefined, [RAMP_GATE_MATRIX_SENTINEL_ENV]: '1' }, () => {
			expect(() => rampGateMatrixMode()).toThrow(/is set but/);
		});
		// An empty value is the same broken plumbing, not a request for the default.
		withEnv({ [RAMP_GATE_MATRIX_ENV]: '', [RAMP_GATE_MATRIX_SENTINEL_ENV]: '1' }, () => {
			expect(() => rampGateMatrixMode()).toThrow(/is set but/);
		});
	});

	it('defaults to the equipped leg for every run that is NOT a matrix leg', () => {
		// The shape CI actually produces on the sharded `test-api` job and on any
		// full-suite run: CI is set, the mode is not, and this module is imported
		// anyway because it sits under the convex/**/__tests__ glob. Keying the
		// throw on CI failed all three shards; only the sentinel may make it fatal.
		for (const ci of [undefined, 'true', 'false', '1']) {
			withEnv(
				{ [RAMP_GATE_MATRIX_ENV]: undefined, [RAMP_GATE_MATRIX_SENTINEL_ENV]: undefined, CI: ci },
				() => {
					expect(rampGateMatrixMode()).toBe('reference_arm');
				}
			);
		}
	});
});

/** Run `body` with `vars` applied to the environment, restoring it afterwards. */
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
	const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
	try {
		for (const [key, value] of Object.entries(vars)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		body();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
