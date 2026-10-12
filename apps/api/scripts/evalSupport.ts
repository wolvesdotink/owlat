/**
 * What the eval scripts share: reading a corpus directory, and the language
 * model they run against from the environment, or null when none is
 * configured (the scripts then stay offline):
 *
 *   INTERPRET_EVAL_MODEL=<model id> plus ANTHROPIC_API_KEY or OPENAI_API_KEY
 *
 * Used by `interpret-eval.ts` and `ai-baseline-eval.ts`, so both name the same
 * switch and neither reaches a provider unless it is set.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';

/** The default corpus directory. */
export const EVAL_CORPUS_DIR = join(
	import.meta.dirname,
	'..',
	'convex',
	'mail',
	'interpret',
	'__eval__',
	'corpus'
);

/** Every `*.json` corpus file in `dir`, parsed, in name order. */
export function readEvalCorpusDir(dir: string): unknown[] {
	return readdirSync(dir)
		.filter((name) => name.endsWith('.json'))
		.sort()
		.map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown);
}

export async function evalLanguageModelFromEnv(): Promise<{
	modelId: string;
	model: LanguageModel;
} | null> {
	const modelId = process.env.INTERPRET_EVAL_MODEL;
	if (!modelId) return null;
	if (process.env.ANTHROPIC_API_KEY) {
		const { createAnthropic } = await import('@ai-sdk/anthropic');
		return { modelId, model: createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(modelId) };
	}
	if (process.env.OPENAI_API_KEY) {
		const { createOpenAI } = await import('@ai-sdk/openai');
		return { modelId, model: createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(modelId) };
	}
	return null;
}
