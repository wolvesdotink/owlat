/**
 * Run the interpretation eval over the corpus, print its metrics and write
 * them to a report file:
 *
 *   bun apps/api/scripts/interpret-eval.ts [corpus-dir] [--out <file>]
 *
 * The report (`__eval__/reportFile.ts`) goes to `--out`, by default
 * `apps/api/.interpret-eval/report.json` (git-ignored).
 *
 * With no model configured it replays the labels themselves (the oracle), so
 * the numbers measure segmentation and grounding alone and must be perfect;
 * the run exits non-zero when they are not.
 *
 * A live run needs a model and its key in the environment:
 *   INTERPRET_EVAL_MODEL=<model id> plus ANTHROPIC_API_KEY or OPENAI_API_KEY
 * It sends every corpus message through the interpretation prompt
 * (`__eval__/liveModel.ts`) and prints the metrics; it does not gate.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseEvalCorpus } from '../convex/mail/interpret/__eval__/corpus';
import {
	formatEvalReport,
	runEval,
	type EvalModel,
} from '../convex/mail/interpret/__eval__/runEval';
import { createLiveEvalModel } from '../convex/mail/interpret/__eval__/liveModel';
import { evalReportFile } from '../convex/mail/interpret/__eval__/reportFile';

/** The live model from the environment, or null (then the oracle replays). */
async function liveModel(): Promise<EvalModel | null> {
	const modelId = process.env.INTERPRET_EVAL_MODEL;
	if (!modelId) return null;
	const { generateObject } = await import('ai');
	let model;
	if (process.env.ANTHROPIC_API_KEY) {
		const { createAnthropic } = await import('@ai-sdk/anthropic');
		model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(modelId);
	} else if (process.env.OPENAI_API_KEY) {
		const { createOpenAI } = await import('@ai-sdk/openai');
		model = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(modelId);
	} else {
		return null;
	}
	return createLiveEvalModel(modelId, async ({ prompt, schema }) => {
		const { object } = await generateObject({ model, schema, prompt, temperature: 0 });
		return { object };
	});
}

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out =
	outAt === -1
		? join(import.meta.dirname, '..', '.interpret-eval', 'report.json')
		: (args[outAt + 1] ?? '');
const positional = outAt === -1 ? args : args.filter((_, i) => i !== outAt && i !== outAt + 1);
const dir =
	positional[0] ??
	join(import.meta.dirname, '..', 'convex', 'mail', 'interpret', '__eval__', 'corpus');
const files = readdirSync(dir)
	.filter((name) => name.endsWith('.json'))
	.sort()
	.map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown);

const model = await liveModel();
const report = await runEval(parseEvalCorpus(files), model ?? undefined);
const file = evalReportFile(report, {
	corpusDir: relative(process.cwd(), dir),
	isOracle: !model,
	now: new Date(),
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(file, null, '\t')}\n`);

if (!model) console.info('No model configured: replaying the labels (oracle).');
console.info(formatEvalReport(report));
console.info(`Report written to ${out}`);
process.exit(file.gate === 'failed' ? 1 : 0);
