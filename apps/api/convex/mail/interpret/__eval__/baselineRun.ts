'use node';

/**
 * One baseline run, end to end: the interpretation eval, the decision tasks
 * through an injected provider, today's classifiers through an injected
 * runner, and the call inventory of each, assembled into the baseline report
 * (`baselineReport.ts`). `apps/api/scripts/ai-baseline-eval.ts` supplies the
 * providers from the environment; tests supply mocks. Every executor is
 * optional, and a part that did not run stays `not_run` in the report.
 *
 * Nothing here reaches a network unless an injected executor does. `'use node'`
 * because the decision runner is.
 */
import { callInventory, type LedgerCallRow } from './callInventory';
import type { EvalThread } from './corpus';
import { EVAL_SPLITS, type EvalSplit } from './decisionLabels';
import {
	DECISION_EVAL_TASKS,
	type DecisionEvalTask,
	type DecisionRun,
	type EvalDecisionProvider,
} from './decisionRun';
import { runDecisionEval } from './decisionRunner';
import { scoreDecisionTask } from './decisionScore';
import { buildBaselineReport, type BaselineReport } from './baselineReport';
import { runEval, type EvalModel } from './runEval';
import { threadsInSplit } from './splits';

export interface BaselineRunOptions {
	split: EvalSplit | 'all';
	now: Date;
	/** The decision provider; absent ⇒ the decision tasks stay `not_run`. */
	decisionProvider?: EvalDecisionProvider;
	/** Today's classifiers (`todayClassifier.ts` `runTodayClassifier`), injected. */
	runToday?: (corpus: readonly EvalThread[], split: EvalSplit | 'all') => Promise<DecisionRun>;
	/** Whether `runToday` calls a model (else it is the Postbox heuristic alone). */
	isTodayModelBacked?: boolean;
	/** The live interpretation model; absent ⇒ the oracle replay. */
	interpretationModel?: EvalModel;
	/** Rows of an exported production ledger, for its own inventory. */
	ledgerRows?: readonly LedgerCallRow[];
	thresholds?: Partial<Record<DecisionEvalTask, number>>;
	/** Wall clock for latency, passed to the decision runner. */
	clock?: () => number;
}

/**
 * Messages an executor processed, per eval path: every message it produced a
 * prediction for, answered or failed. A message settled without a model call
 * (the Postbox heuristic) counts, at zero requests; a message the executor
 * never handled (the Team baseline without a model) does not.
 */
export function processedMessageCounts(
	corpus: readonly EvalThread[],
	run: DecisionRun,
	executor: 'decision' | 'today'
): Record<string, number> {
	const modes = new Map(corpus.map((t) => [t.id, t.mode]));
	const seen = new Set<string>();
	const counts: Record<string, number> = {};
	for (const p of run.predictions) {
		const key = `${p.threadId}/${p.messageId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const surface = modes.get(p.threadId) === 'actions' ? 'team' : 'postbox';
		const path = `eval.${executor}.${surface}`;
		counts[path] = (counts[path] ?? 0) + 1;
	}
	return counts;
}

export async function runBaseline(
	corpus: readonly EvalThread[],
	options: BaselineRunOptions
): Promise<BaselineReport> {
	const inSplit = threadsInSplit(corpus, options.split);

	const interpretation = await runEval(inSplit, options.interpretationModel);
	const today = options.runToday ? await options.runToday(corpus, options.split) : undefined;
	const decision = options.decisionProvider
		? await runDecisionEval(corpus, {
				provider: options.decisionProvider,
				split: options.split,
				...(options.clock ? { now: options.clock } : {}),
			})
		: undefined;

	return buildBaselineReport({
		now: options.now,
		corpus: {
			threads: corpus.length,
			split: options.split,
			splitThreads: inSplit.length,
			labelledMessages: inSplit.reduce((n, t) => n + t.labels.decisions.length, 0),
		},
		interpretation: { report: interpretation, isLive: !!options.interpretationModel },
		...(decision
			? {
					decision: {
						executor: decision.executor,
						tasks: DECISION_EVAL_TASKS.map((task) =>
							scoreDecisionTask(corpus, decision, task, {
								...(today ? { baseline: today } : {}),
								...(options.thresholds ? { thresholds: options.thresholds } : {}),
							})
						),
						calls: callInventory(decision.rows, {
							messageCounts: processedMessageCounts(corpus, decision, 'decision'),
						}),
					},
				}
			: {}),
		...(today
			? {
					today: {
						executor: today.executor,
						isModelBacked: !!options.isTodayModelBacked,
						// Scored on their own: today's numbers do not need a candidate.
						tasks: DECISION_EVAL_TASKS.filter((task) =>
							today.predictions.some((p) => p.task === task)
						).map((task) => scoreDecisionTask(corpus, today, task)),
						calls: callInventory(today.rows, {
							messageCounts: processedMessageCounts(corpus, today, 'today'),
						}),
					},
				}
			: {}),
		...(options.ledgerRows ? { ledger: callInventory(options.ledgerRows) } : {}),
		notes: [
			options.decisionProvider
				? `Decision tasks answered by ${options.decisionProvider.name}.`
				: 'Decision tasks not run: no decision provider configured.',
			options.isTodayModelBacked
				? "Today's classifiers ran with a model. Their triage and disposition come from the Team classifier, so Postbox messages count as labelled but unanswered there."
				: "Today's classifiers ran without a model: the Postbox heuristic only, no Team baseline.",
			options.interpretationModel
				? 'Interpretation ran live.'
				: 'Interpretation is the oracle replay: it measures segmentation and grounding, not a model.',
		],
	});
}

export interface BaselineArgs {
	split: EvalSplit | 'all';
	/** Where to write the report; null ⇒ the default (git-ignored) path. */
	out: string | null;
	/** Write the checked-in `baseline/report.json` instead of `out`. */
	isCheckedInBaseline: boolean;
	/** An exported `llmUsageEvents/documents.jsonl` to inventory. */
	ledger: string | null;
	thresholds: Partial<Record<DecisionEvalTask, number>>;
	corpusDir: string | null;
}

/**
 * `[corpus-dir] [--split heldout|calibration|train|all] [--out <file>]
 * [--write-baseline] [--ledger <documents.jsonl>] [--threshold <task>=<p>]…`
 */
export function parseBaselineArgs(argv: readonly string[]): BaselineArgs {
	const args: BaselineArgs = {
		split: 'heldout',
		out: null,
		isCheckedInBaseline: false,
		ledger: null,
		thresholds: {},
		corpusDir: null,
	};
	const value = (i: number, flag: string) => {
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
		return next;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === '--split') {
			const split = value(i++, arg);
			if (!(EVAL_SPLITS as readonly string[]).includes(split) && split !== 'all') {
				throw new Error(`unknown split ${split}`);
			}
			args.split = split as EvalSplit | 'all';
		} else if (arg === '--out') args.out = value(i++, arg);
		else if (arg === '--write-baseline') args.isCheckedInBaseline = true;
		else if (arg === '--ledger') args.ledger = value(i++, arg);
		else if (arg === '--threshold') {
			const [task, raw] = value(i++, arg).split('=');
			const p = Number(raw);
			if (!(DECISION_EVAL_TASKS as readonly string[]).includes(task ?? '')) {
				throw new Error(`unknown task ${task}`);
			}
			if (!(p >= 0 && p <= 1)) throw new Error(`threshold for ${task} must lie in [0, 1]`);
			args.thresholds[task as DecisionEvalTask] = p;
		} else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
		else if (args.corpusDir === null) args.corpusDir = arg;
		else throw new Error(`unexpected argument ${arg}`);
	}
	if (args.isCheckedInBaseline && args.split !== 'heldout') {
		throw new Error('the checked-in baseline reports the held-out split only');
	}
	return args;
}
