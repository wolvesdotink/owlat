/**
 * The baseline report format: the checked-in skeleton, a full run with mocked
 * executors, and the CLI's argument parsing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DecisionResult } from '../../../../lib/decisionProviders/types';
import {
	baselineReportSchema,
	formatBaselineReport,
	notRunBaselineReport,
} from '../baselineReport';
import { parseBaselineArgs, runBaseline } from '../baselineRun';
import { DECISION_EVAL_TASKS, type EvalDecisionProvider } from '../decisionRun';
import type { EvalModel } from '../runEval';
import { runTodayClassifier } from '../todayClassifier';
import { loadCorpus } from './corpusFixture';

const corpus = loadCorpus();
const now = new Date(Date.UTC(2026, 9, 12, 8));

const provider: EvalDecisionProvider = {
	name: 'mock:decide-1',
	async ask({ questions }) {
		const answers = Object.fromEntries(
			Object.entries(questions).map(([key, q]) => {
				if (q.type !== 'choice') return [key, { kind: 'noul', probability: 0.7 }];
				const options = Object.keys(q.criteria);
				const probabilities = Object.fromEntries(options.map((o) => [o, 1 / options.length]));
				return [
					key,
					{ kind: 'choice', value: options[0], probabilities, confidence: 1 / options.length },
				];
			})
		);
		return {
			answers,
			usage: { promptTokens: 300, completionTokens: 10, totalTokens: 310 },
			modelUsed: 'mock-decide-1',
			provenance: 'local',
			calibrated: false,
		} as DecisionResult;
	},
};

describe('the checked-in baseline report', () => {
	it('is the not-run skeleton: the format, and no numbers', () => {
		const file = JSON.parse(
			readFileSync(join(import.meta.dirname, '..', 'baseline', 'report.json'), 'utf8')
		) as unknown;
		expect(baselineReportSchema.parse(file)).toEqual(notRunBaselineReport());
		expect(notRunBaselineReport().tasks.map((t) => t.task)).toEqual([...DECISION_EVAL_TASKS]);
	});
});

describe('runBaseline', () => {
	it('runs offline by default: oracle interpretation, heuristic Postbox baseline, no decisions', async () => {
		const report = await runBaseline(corpus, {
			split: 'heldout',
			now,
			runToday: (all, split) => runTodayClassifier(all, { split }),
		});
		expect(baselineReportSchema.parse(report)).toEqual(report);
		expect(report.status).toBe('partial');
		expect(report.executors).toEqual({
			decision: null,
			today: 'today (heuristic only)',
			interpretation: 'oracle',
		});
		expect(report.tasks.every((t) => t.status === 'not_run')).toBe(true);
		// Today's classifier is scored without any candidate provider.
		const scoredToday = report.todayTasks.filter((t) => t.status === 'scored');
		expect(scoredToday.map((t) => t.task)).toEqual(['postbox_category']);
		const category = scoredToday[0]?.report;
		expect(category).toMatchObject({ probability: 'none', threshold: null, failed: 0 });
		expect(category?.answered).toBe(category?.labelled);
		expect(category?.accuracy.n).toBeGreaterThan(0);
		expect(Object.keys(category?.byLanguage ?? {}).sort()).toEqual(['de', 'en']);
		expect(category?.perClass['person']?.recall.n).toBeGreaterThan(0);
		expect(category?.calibration).toMatchObject({ brier: null, adapters: 'none' });
		expect(category?.baseline).toBeNull();
		expect(report.interpretation?.recall).toBe(1);
		// The heuristic made no call: every Postbox message costs zero requests.
		const postbox = report.calls.today?.paths.find((p) => p.path === 'eval.today.postbox');
		expect(postbox).toMatchObject({ requests: 0, isRootsOnly: false });
		expect(postbox?.messages).toBeGreaterThan(0);
		// No model, no Team baseline: the Team path is absent, not zero calls.
		expect(report.calls.today?.paths.map((p) => p.path)).toEqual(['eval.today.postbox']);
		expect(report.calls.decision).toBeNull();
		expect(report.notes[0]).toMatch(/not run/);
		expect(formatBaselineReport(report)).toContain('- triage: not run');
	});

	it('scores every decision task on the split and inventories its calls', async () => {
		// A live interpretation model that finds nothing: recall 0, and the run is live.
		const model: EvalModel = {
			name: 'mock-writer',
			interpret: async ({ mode }) => ({ output: { mode, items: [], transitions: [] } }),
		};
		const report = await runBaseline(corpus, {
			split: 'calibration',
			now,
			decisionProvider: provider,
			runToday: (all, split) =>
				runTodayClassifier(all, {
					split,
					generate: async ({ feature }) => ({
						object:
							feature === 'postbox_category'
								? { category: 'person' }
								: {
										category: 'support',
										priority: 'normal',
										sentiment: 'neutral',
										intent: 'question',
										confidence: 0.8,
										kind: 'personal',
										needsResponse: true,
										language: 'en',
										importance: 0.5,
									},
					}),
				}),
			isTodayModelBacked: true,
			interpretationModel: model,
			ledgerRows: [
				{
					feature: 'agent_classify',
					rootRequestId: 'team:abc',
					promptTokens: 1,
					completionTokens: 1,
					totalTokens: 2,
					costUsd: 0.0001,
				},
			],
			thresholds: { disposition: 0.8 },
			clock: () => 0,
		});
		expect(baselineReportSchema.parse(report)).toEqual(report);
		expect(report.status).toBe('complete');
		expect(report.corpus).toMatchObject({ split: 'calibration', threads: corpus.length });
		expect(report.tasks.every((t) => t.status === 'scored')).toBe(true);
		// With a model, today's Team classifier answers triage and disposition too.
		expect(report.todayTasks.filter((t) => t.status === 'scored').map((t) => t.task)).toEqual([
			'triage',
			'postbox_category',
			'team_category',
			'disposition',
		]);
		const todayDisposition = report.todayTasks.find((t) => t.task === 'disposition')?.report;
		expect(todayDisposition).toMatchObject({ probability: 'none', threshold: null });
		const disposition = report.tasks.find((t) => t.task === 'disposition')?.report;
		// 0.7 < 0.8: every message judged informational at the given threshold.
		expect(disposition?.threshold).toBe(0.8);
		expect(disposition?.perClass['reply']?.recall.estimate).toBe(0);
		expect(disposition?.baseline?.executor).toBe('today (heuristic + model)');
		expect(disposition?.calibration.adapters).toBe('uncalibrated');
		const teamMessages = corpus
			.filter((t) => t.split === 'calibration' && t.mode === 'actions')
			.reduce((n, t) => n + t.labels.decisions.length, 0);
		const team = report.calls.decision?.paths.find((p) => p.path === 'eval.decision.team');
		expect(team?.messages).toBe(teamMessages);
		expect(report.calls.today?.paths.find((p) => p.path === 'eval.today.team')?.messages).toBe(
			teamMessages
		);
		// triage + category bundle per message, plus necessity and draft calls.
		expect(team?.requestsPerMessage.mean).toBeGreaterThanOrEqual(2);
		expect(report.calls.ledger?.paths.map((p) => p.path)).toEqual(['team']);
		expect(report.interpretation?.model).toBe('mock-writer');
		const text = formatBaselineReport(report);
		expect(text).toContain('disposition (noul_probability >= 0.8)');
		expect(text).toContain('triage (choice_peakedness)');
		expect(text).toContain('calls (decision):');
		expect(text).toContain("today's classifiers:");
		expect(text).toContain('disposition (none)');
	});
});

describe('parseBaselineArgs', () => {
	it('defaults to the held-out split and the git-ignored output', () => {
		expect(parseBaselineArgs([])).toEqual({
			split: 'heldout',
			out: null,
			isCheckedInBaseline: false,
			ledger: null,
			thresholds: {},
			corpusDir: null,
		});
	});

	it('reads every flag', () => {
		expect(
			parseBaselineArgs([
				'dir',
				'--split',
				'calibration',
				'--out',
				'x.json',
				'--ledger',
				'docs.jsonl',
				'--threshold',
				'disposition=0.35',
				'--threshold',
				'necessity=0.6',
			])
		).toEqual({
			split: 'calibration',
			out: 'x.json',
			isCheckedInBaseline: false,
			ledger: 'docs.jsonl',
			thresholds: { disposition: 0.35, necessity: 0.6 },
			corpusDir: 'dir',
		});
		expect(parseBaselineArgs(['--write-baseline']).isCheckedInBaseline).toBe(true);
	});

	it('refuses what it cannot honour', () => {
		expect(() => parseBaselineArgs(['--split', 'test'])).toThrow(/unknown split/);
		expect(() => parseBaselineArgs(['--threshold', 'tone=0.5'])).toThrow(/unknown task/);
		expect(() => parseBaselineArgs(['--threshold', 'disposition=2'])).toThrow(/\[0, 1\]/);
		expect(() => parseBaselineArgs(['--out'])).toThrow(/needs a value/);
		expect(() => parseBaselineArgs(['--fast'])).toThrow(/unknown flag/);
		expect(() => parseBaselineArgs(['a', 'b'])).toThrow(/unexpected/);
		expect(() => parseBaselineArgs(['--write-baseline', '--split', 'train'])).toThrow(/held-out/);
	});
});
