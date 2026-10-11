/**
 * Produce the AI routing baseline report (`__eval__/baselineReport.ts`):
 *
 *   bun apps/api/scripts/ai-baseline-eval.ts [corpus-dir]
 *     [--split heldout|calibration|train|all]   default: heldout
 *     [--out <file>]                            default: apps/api/.interpret-eval/baseline.json
 *     [--write-baseline]                        write the checked-in __eval__/baseline/report.json
 *     [--ledger <documents.jsonl>]              also inventory an exported production ledger
 *     [--threshold <task>=<p>]                  Noul threshold per task (fit on --split calibration)
 *
 * Nothing reaches a provider unless the environment says so. With nothing set
 * the run is offline: the interpretation oracle, the Postbox heuristic as
 * today's classifier, and every decision task `not_run`.
 *
 * Live parts, each opt-in (they cost money on a paid provider):
 *   - Today's classifiers, the live interpretation run, and the language-backed
 *     decision adapter: INTERPRET_EVAL_MODEL plus ANTHROPIC_API_KEY or
 *     OPENAI_API_KEY (`evalSupport.ts`).
 *   - Decision tasks: DECISION_EVAL_PROVIDER=typesafe|local|llm, with
 *     TYPESAFE_API_KEY for `typesafe`, optional DECISION_EVAL_BASE_URL (a local
 *     engine, a proxy) and DECISION_EVAL_MODEL (a pinned model id). `local` is
 *     the operator's own engine and bills nothing.
 *
 * The production ledger: `npx convex export --path snapshot.zip`, unzip it, and
 * pass `llmUsageEvents/documents.jsonl` with `--ledger`. Rows written before
 * the Phase 1a ledger columns carry no root request and are counted as
 * unattributed.
 *
 * Thresholds: run once with `--split calibration`, read the reliability bins,
 * then run the held-out split with the chosen `--threshold`s. Never fit and
 * report on the same split.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProviderClientConfig } from '../convex/lib/llmProviders/types';
import { parseEvalCorpus } from '../convex/mail/interpret/__eval__/corpus';
import {
	baselineReportSchema,
	formatBaselineReport,
} from '../convex/mail/interpret/__eval__/baselineReport';
import { parseBaselineArgs, runBaseline } from '../convex/mail/interpret/__eval__/baselineRun';
import { ledgerRowsFromJsonl } from '../convex/mail/interpret/__eval__/callInventory';
import {
	decisionProviderFromAdapter,
	type EvalDecisionProvider,
} from '../convex/mail/interpret/__eval__/decisionRunner';
import { createLiveEvalModel } from '../convex/mail/interpret/__eval__/liveModel';
import {
	runTodayClassifier,
	type TodayGenerate,
} from '../convex/mail/interpret/__eval__/todayClassifier';
import { EVAL_CORPUS_DIR, evalLanguageModelFromEnv, readEvalCorpusDir } from './evalSupport';

const args = parseBaselineArgs(process.argv.slice(2));
const corpus = parseEvalCorpus(readEvalCorpusDir(args.corpusDir ?? EVAL_CORPUS_DIR));
const language = await evalLanguageModelFromEnv();
const { runLlmObject } = await import('../convex/lib/llm/dispatch');

/** The decision provider from the environment, or null (the tasks stay `not_run`). */
async function decisionProvider(): Promise<EvalDecisionProvider | null> {
	const kind = process.env.DECISION_EVAL_PROVIDER;
	if (!kind) return null;
	const { DECISION_PROVIDER_KINDS, decisionProviderFor } =
		await import('../convex/lib/decisionProviders');
	const known = DECISION_PROVIDER_KINDS.find((k) => k === kind);
	if (!known) throw new Error(`DECISION_EVAL_PROVIDER must be one of ${DECISION_PROVIDER_KINDS}`);
	if (known === 'llm' && !language) {
		throw new Error(
			'The llm decision adapter answers on INTERPRET_EVAL_MODEL; set it and its key.'
		);
	}
	const adapter = decisionProviderFor(known);
	const apiKey = adapter.apiKeyEnv ? process.env[adapter.apiKeyEnv] : undefined;
	const config: ProviderClientConfig = {
		...(apiKey ? { apiKey } : {}),
		...(process.env.DECISION_EVAL_BASE_URL ? { baseUrl: process.env.DECISION_EVAL_BASE_URL } : {}),
	};
	adapter.validateCredentials(config);
	return decisionProviderFromAdapter(adapter, config, {
		...(process.env.DECISION_EVAL_MODEL ? { modelId: process.env.DECISION_EVAL_MODEL } : {}),
		...(known === 'llm' && language ? { languageModel: language.model } : {}),
	});
}

/** Today's model call through the production dispatch, as the pipelines make it. */
const todayGenerate: TodayGenerate | undefined = language
	? async ({ prompt, schema, temperature }) => {
			// One attempt per call, so one ledger row stands for one provider request.
			const { object, tokenUsage, modelUsed } = await runLlmObject({
				model: language.model,
				schema,
				prompt,
				temperature,
				maxAttempts: 1,
			});
			return { object, usage: tokenUsage, modelUsed: modelUsed ?? language.modelId };
		}
	: undefined;

const interpretationModel = language
	? createLiveEvalModel(language.modelId, async ({ prompt, schema }) => {
			const { object } = await runLlmObject({
				model: language.model,
				schema,
				prompt,
				temperature: 0,
				maxAttempts: 1,
			});
			return { object };
		})
	: undefined;

const provider = await decisionProvider();
const ledger = args.ledger ? ledgerRowsFromJsonl(readFileSync(args.ledger, 'utf8')) : null;
const report = await runBaseline(corpus, {
	split: args.split,
	now: new Date(),
	...(provider ? { decisionProvider: provider } : {}),
	runToday: (all, split) =>
		runTodayClassifier(all, { split, ...(todayGenerate ? { generate: todayGenerate } : {}) }),
	isTodayModelBacked: !!todayGenerate,
	...(interpretationModel ? { interpretationModel } : {}),
	...(ledger ? { ledgerRows: ledger.rows } : {}),
	thresholds: args.thresholds,
});
if (ledger && ledger.skipped > 0) {
	report.notes.unshift(`${ledger.skipped} ledger lines were not ledger rows and were skipped.`);
}

baselineReportSchema.parse(report);
const out = args.isCheckedInBaseline
	? join(
			import.meta.dirname,
			'..',
			'convex',
			'mail',
			'interpret',
			'__eval__',
			'baseline',
			'report.json'
		)
	: (args.out ?? join(import.meta.dirname, '..', '.interpret-eval', 'baseline.json'));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, '\t')}\n`);
console.info(formatBaselineReport(report));
console.info(`Report written to ${out}`);
