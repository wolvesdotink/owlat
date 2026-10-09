import { describe, expect, it } from 'vitest';
import { EVAL_REPORT_FILE_VERSION, evalReportFile, isOraclePerfect } from '../reportFile';
import type { EvalReport } from '../runEval';

const perfect: EvalReport = {
	model: 'oracle',
	threads: 60,
	messages: 90,
	skippedIneligible: 2,
	labelledItems: 120,
	recall: 1,
	precision: 1,
	ownership: 1,
	evidenceValidity: 1,
	unsupportedRate: 0,
	costUsd: 0,
	incompleteMessages: 0,
	perSlice: {},
	worstSlice: null,
	missed: [],
	proposals: 0,
	trapsAccepted: [],
	flagsMissed: [],
	notesLeaked: [],
};
const now = new Date(Date.UTC(2026, 9, 9, 12));

describe('evalReportFile', () => {
	it('records the metrics and passes a perfect oracle replay', () => {
		const file = evalReportFile(perfect, { corpusDir: 'corpus', isOracle: true, now });
		expect(file).toEqual({
			version: EVAL_REPORT_FILE_VERSION,
			generatedAt: '2026-10-09T12:00:00.000Z',
			corpusDir: 'corpus',
			isOracle: true,
			gate: 'passed',
			report: perfect,
		});
		expect(JSON.parse(JSON.stringify(file))).toEqual(file);
	});

	it('fails an oracle replay that misses anything, and never gates a live run', () => {
		const missed = { ...perfect, recall: 0.98, missed: [{ threadId: 't1', labelId: 'l1' }] };
		expect(isOraclePerfect(missed)).toBe(false);
		expect(evalReportFile(missed, { corpusDir: 'c', isOracle: true, now }).gate).toBe('failed');
		expect(evalReportFile(missed, { corpusDir: 'c', isOracle: false, now }).gate).toBe('none');
		const leaked = { ...perfect, notesLeaked: [{ threadId: 't1', noteId: 'n1' }] };
		expect(isOraclePerfect(leaked)).toBe(false);
	});
});
