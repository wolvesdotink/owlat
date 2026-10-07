/**
 * Run the interpretation eval over the corpus and print its metrics:
 *
 *   bun apps/api/scripts/interpret-eval.ts [corpus-dir]
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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEvalCorpus } from '../convex/mail/interpret/__eval__/corpus';
import { formatEvalReport, runEval, type EvalModel } from '../convex/mail/interpret/__eval__/runEval';
import { createLiveEvalModel } from '../convex/mail/interpret/__eval__/liveModel';

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

const dir =
	process.argv[2] ??
	join(import.meta.dirname, '..', 'convex', 'mail', 'interpret', '__eval__', 'corpus');
const files = readdirSync(dir)
	.filter((name) => name.endsWith('.json'))
	.sort()
	.map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown);

const model = await liveModel();
const report = await runEval(parseEvalCorpus(files), model ?? undefined);
if (model) {
	console.info(formatEvalReport(report));
	process.exit(0);
}
console.info('No model configured: replaying the labels (oracle).');
console.info(formatEvalReport(report));

const perfect =
	report.recall === 1 &&
	report.precision === 1 &&
	report.ownership === 1 &&
	report.evidenceValidity === 1 &&
	report.trapsAccepted.length === 0 &&
	report.flagsMissed.length === 0 &&
	report.notesLeaked.length === 0;
process.exit(perfect ? 0 : 1);
