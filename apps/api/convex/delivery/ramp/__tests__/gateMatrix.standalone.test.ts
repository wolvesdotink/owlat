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
	externalDataAllowed,
	matrixEvaluator,
	matrixInput,
	rampGateMatrixMode,
} from './gateMatrixMode';
import { arm, seeds } from './gateFixtures';

const MODE = rampGateMatrixMode();
const EVALUATOR = matrixEvaluator(MODE);

const WORKFLOW = readFileSync(
	fileURLToPath(new URL('../../../../../../.github/workflows/test.yml', import.meta.url)),
	'utf8'
);

describe('the CI matrix exists and runs both configurations', () => {
	it('declares both legs', () => {
		expect(WORKFLOW).toContain('ramp-gate-matrix');
		expect(WORKFLOW).toContain('mode: [reference_arm, standalone]');
	});

	it('passes the mode through the environment variable this suite reads', () => {
		expect(WORKFLOW).toContain(`${RAMP_GATE_MATRIX_ENV}: \${{ matrix.mode }}`);
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
		expect(['high', 'medium', 'low']).toContain(evaluation.confidence);
	});

	it('rejects an unrecognised mode rather than falling back to the equipped one', () => {
		const previous = process.env[RAMP_GATE_MATRIX_ENV];
		process.env[RAMP_GATE_MATRIX_ENV] = 'not_a_mode';
		try {
			expect(() => rampGateMatrixMode()).toThrow(RAMP_GATE_MATRIX_ENV);
		} finally {
			if (previous === undefined) delete process.env[RAMP_GATE_MATRIX_ENV];
			else process.env[RAMP_GATE_MATRIX_ENV] = previous;
		}
	});
});
