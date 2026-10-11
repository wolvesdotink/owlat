/**
 * The baseline report (AI routing plan Phase 1a: "Check in the baseline
 * report"): one versioned JSON file that holds everything a later phase is
 * compared against:
 *
 *   - `interpretation`: the interpretation eval (`runEval.ts`), oracle or live;
 *   - `tasks`: one entry per decision task (`decisionScore.ts`), `not_run`
 *     until a provider answered it;
 *   - `calls`: the call inventory (`callInventory.ts`) of the decision run, of
 *     today's classifiers, and of an exported production ledger when given;
 *   - `executors`: what produced each part, so two reports are comparable.
 *
 * The checked-in file (`baseline/report.json`) starts as the `not_run`
 * skeleton: the format, no numbers. `apps/api/scripts/ai-baseline-eval.ts`
 * overwrites it after a real run; no number is claimed without one.
 *
 * Pure and isolate-safe: building and formatting are separate from writing.
 */
import { z } from 'zod';
import type { CallInventory } from './callInventory';
import { EVAL_SPLITS, type EvalSplit } from './decisionLabels';
import { DECISION_EVAL_TASKS, type DecisionEvalTask } from './decisionRunner';
import type { DecisionTaskReport } from './decisionScore';
import type { EvalReport } from './runEval';
import type { Interval } from './stats';

/** Bumped when the file's shape changes. */
export const BASELINE_REPORT_VERSION = 1;

export interface BaselineTaskEntry {
	task: DecisionEvalTask;
	status: 'not_run' | 'scored';
	report: DecisionTaskReport | null;
}

export interface BaselineReport {
	version: typeof BASELINE_REPORT_VERSION;
	/** `not_run`: nothing ran. `partial`: some parts ran. `complete`: every part ran live. */
	status: 'not_run' | 'partial' | 'complete';
	generatedAt: string | null;
	corpus: {
		threads: number;
		split: EvalSplit | 'all';
		splitThreads: number;
		labelledMessages: number;
	} | null;
	executors: { decision: string | null; today: string | null; interpretation: string | null };
	interpretation: EvalReport | null;
	tasks: BaselineTaskEntry[];
	calls: {
		decision: CallInventory | null;
		today: CallInventory | null;
		ledger: CallInventory | null;
	};
	notes: string[];
}

const intervalSchema = z
	.object({
		successes: z.number(),
		n: z.number(),
		estimate: z.number().nullable(),
		low: z.number().nullable(),
		high: z.number().nullable(),
	})
	.strict();

const taskReportSchema = z
	.object({
		task: z.enum(DECISION_EVAL_TASKS),
		questionType: z.enum(['choice', 'noul']),
		probability: z.enum(['noul_probability', 'choice_peakedness']),
		threshold: z.number().nullable(),
		labelled: z.number(),
		answered: z.number(),
		failed: z.number(),
		accuracy: intervalSchema,
		perClass: z.record(z.string(), z.object({ support: z.number() }).passthrough()),
		byLanguage: z.record(z.string(), z.object({ accuracy: intervalSchema }).passthrough()),
		calibration: z
			.object({
				adapters: z.enum(['calibrated', 'uncalibrated', 'mixed', 'none']),
				brier: z.number().nullable(),
				distributionBrier: z.number().nullable(),
				reliability: z.array(z.object({ count: z.number() }).passthrough()),
				ece: z.number().nullable(),
			})
			.strict(),
		consequential: z
			.object({
				description: z.string(),
				errors: z.array(z.object({ threadId: z.string() }).passthrough()),
				rate: intervalSchema,
				upper95WhenNoneObserved: z.number().nullable(),
			})
			.strict(),
		baseline: z.object({ executor: z.string(), accuracy: intervalSchema }).passthrough().nullable(),
		agreement: z
			.object({ compared: z.number(), rate: intervalSchema, kappa: z.number().nullable() })
			.passthrough()
			.nullable(),
	})
	.strict();

const inventorySchema = z
	.object({ rows: z.number(), unattributedRows: z.number(), paths: z.array(z.unknown()) })
	.passthrough();

/** The file format. A reader validates with it before comparing two reports. */
export const baselineReportSchema = z
	.object({
		version: z.literal(BASELINE_REPORT_VERSION),
		status: z.enum(['not_run', 'partial', 'complete']),
		generatedAt: z.string().nullable(),
		corpus: z
			.object({
				threads: z.number(),
				split: z.enum([...EVAL_SPLITS, 'all']),
				splitThreads: z.number(),
				labelledMessages: z.number(),
			})
			.strict()
			.nullable(),
		executors: z
			.object({
				decision: z.string().nullable(),
				today: z.string().nullable(),
				interpretation: z.string().nullable(),
			})
			.strict(),
		interpretation: z.object({ model: z.string(), recall: z.number() }).passthrough().nullable(),
		tasks: z.array(
			z
				.object({
					task: z.enum(DECISION_EVAL_TASKS),
					status: z.enum(['not_run', 'scored']),
					report: taskReportSchema.nullable(),
				})
				.strict()
		),
		calls: z
			.object({
				decision: inventorySchema.nullable(),
				today: inventorySchema.nullable(),
				ledger: inventorySchema.nullable(),
			})
			.strict(),
		notes: z.array(z.string()),
	})
	.strict();

/** Always true of a report, run or not. */
const STANDING_NOTES = [
	'Intervals are 95% Wilson score intervals over the reported split only.',
	'Zero observed consequential errors is not a safety guarantee; see upper95WhenNoneObserved.',
	'Choice tasks score Choice peakedness (confidence), which is not a probability of being right.',
];

/** The checked-in skeleton: every part `not_run`, no numbers. */
export function notRunBaselineReport(): BaselineReport {
	return {
		version: BASELINE_REPORT_VERSION,
		status: 'not_run',
		generatedAt: null,
		corpus: null,
		executors: { decision: null, today: null, interpretation: null },
		interpretation: null,
		tasks: DECISION_EVAL_TASKS.map((task) => ({ task, status: 'not_run', report: null })),
		calls: { decision: null, today: null, ledger: null },
		notes: [
			'Not run: no provider has answered yet. Run apps/api/scripts/ai-baseline-eval.ts with a provider configured.',
			...STANDING_NOTES,
		],
	};
}

export interface BaselineInputs {
	now: Date;
	corpus: NonNullable<BaselineReport['corpus']>;
	interpretation?: { report: EvalReport; isLive: boolean };
	decision?: { executor: string; tasks: DecisionTaskReport[]; calls: CallInventory };
	today?: { executor: string; isModelBacked: boolean; calls: CallInventory };
	ledger?: CallInventory;
	notes?: string[];
}

/** Assemble a report from whatever ran. */
export function buildBaselineReport(inputs: BaselineInputs): BaselineReport {
	const scored = new Map(inputs.decision?.tasks.map((t) => [t.task, t]));
	const isComplete =
		!!inputs.decision && !!inputs.today?.isModelBacked && !!inputs.interpretation?.isLive;
	const ranAnything = !!inputs.decision || !!inputs.today || !!inputs.interpretation;
	return {
		version: BASELINE_REPORT_VERSION,
		status: isComplete ? 'complete' : ranAnything ? 'partial' : 'not_run',
		generatedAt: inputs.now.toISOString(),
		corpus: inputs.corpus,
		executors: {
			decision: inputs.decision?.executor ?? null,
			today: inputs.today?.executor ?? null,
			interpretation: inputs.interpretation?.report.model ?? null,
		},
		interpretation: inputs.interpretation?.report ?? null,
		tasks: DECISION_EVAL_TASKS.map((task) => {
			const report = scored.get(task) ?? null;
			return { task, status: report ? 'scored' : 'not_run', report };
		}),
		calls: {
			decision: inputs.decision?.calls ?? null,
			today: inputs.today?.calls ?? null,
			ledger: inputs.ledger ?? null,
		},
		notes: [...(inputs.notes ?? []), ...STANDING_NOTES],
	};
}

const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const interval = (i: Interval) =>
	i.estimate === null ? 'n/a' : `${pct(i.estimate)} [${pct(i.low)}, ${pct(i.high)}] n=${i.n}`;
const num = (value: number | null, digits = 3) => (value === null ? 'n/a' : value.toFixed(digits));

/** The report as the CLI prints it. */
export function formatBaselineReport(report: BaselineReport): string {
	const lines = [
		`AI routing baseline (${report.status})`,
		report.corpus
			? `corpus: ${report.corpus.splitThreads} of ${report.corpus.threads} threads (${report.corpus.split}), ${report.corpus.labelledMessages} labelled messages`
			: 'corpus: n/a',
		`decision executor: ${report.executors.decision ?? 'not run'}`,
		`today's classifier: ${report.executors.today ?? 'not run'}`,
		`interpretation: ${report.executors.interpretation ?? 'not run'}`,
	];
	for (const entry of report.tasks) {
		const r = entry.report;
		if (!r) {
			lines.push(`- ${entry.task}: not run`);
			continue;
		}
		lines.push(
			`- ${entry.task} (${r.probability}${r.threshold === null ? '' : ` >= ${r.threshold}`}): accuracy ${interval(r.accuracy)}, failed ${r.failed}`,
			`    brier ${num(r.calibration.brier)}  ece ${num(r.calibration.ece)}  adapters ${r.calibration.adapters}`,
			`    consequential ${interval(r.consequential.rate)} — ${r.consequential.description}`
		);
		for (const [locale, slice] of Object.entries(r.byLanguage)) {
			lines.push(`    ${locale}: accuracy ${interval(slice.accuracy)}`);
		}
		for (const [cls, score] of Object.entries(r.perClass)) {
			lines.push(`    recall ${cls}: ${interval(score.recall)}`);
		}
		if (r.baseline && r.agreement) {
			lines.push(
				`    today (${r.baseline.executor}): accuracy ${interval(r.baseline.accuracy)}; agreement ${interval(r.agreement.rate)}, kappa ${num(r.agreement.kappa)}`
			);
		}
	}
	for (const [source, inventory] of Object.entries(report.calls)) {
		if (!inventory) continue;
		lines.push(`calls (${source}):`);
		for (const path of inventory.paths) {
			lines.push(
				`  ${path.path}: ${path.messages} messages, ${num(path.requestsPerMessage.mean, 2)} requests/message (p95 ${num(path.requestsPerMessage.p95, 0)}), $${num(path.costPerMessage.mean, 6)}/message${path.shadowRequests > 0 ? `, shadow $${num(path.shadowCostUsd, 6)}` : ''}${path.isRootsOnly ? ' (messages with calls only)' : ''}`
			);
		}
		if (inventory.unattributedRows > 0) {
			lines.push(`  unattributed: ${inventory.unattributedRows} rows without a root request`);
		}
	}
	lines.push(...report.notes.map((note) => `note: ${note}`));
	return lines.join('\n');
}
