/**
 * The interpretation eval's metrics report file (ADR-0072 "Eval gate").
 *
 * `apps/api/scripts/interpret-eval.ts` writes it after every run, oracle or
 * live, so a run leaves a record to compare against the next one: the
 * headline metrics, the per-slice recall, the misses, and whether the run
 * passed its gate. Only the oracle replay gates (its numbers measure
 * segmentation and grounding alone and must be perfect); a live run records
 * `gate: 'none'`.
 *
 * Pure: building the file is separate from writing it.
 */

import type { EvalReport } from './runEval';

/** Bumped when the file's shape changes, so a reader can tell old files apart. */
export const EVAL_REPORT_FILE_VERSION = 1;

export interface EvalReportFile {
	version: number;
	generatedAt: string;
	corpusDir: string;
	isOracle: boolean;
	gate: 'passed' | 'failed' | 'none';
	report: EvalReport;
}

/** The oracle replay must be perfect: every label found, grounded and owned. */
export function isOraclePerfect(report: EvalReport): boolean {
	return (
		report.recall === 1 &&
		report.precision === 1 &&
		report.ownership === 1 &&
		report.evidenceValidity === 1 &&
		report.trapsAccepted.length === 0 &&
		report.flagsMissed.length === 0 &&
		report.notesLeaked.length === 0
	);
}

export function evalReportFile(
	report: EvalReport,
	meta: { corpusDir: string; isOracle: boolean; now: Date }
): EvalReportFile {
	return {
		version: EVAL_REPORT_FILE_VERSION,
		generatedAt: meta.now.toISOString(),
		corpusDir: meta.corpusDir,
		isOracle: meta.isOracle,
		gate: meta.isOracle ? (isOraclePerfect(report) ? 'passed' : 'failed') : 'none',
		report,
	};
}
