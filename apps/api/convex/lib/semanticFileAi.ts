'use node';

/**
 * The model-facing parts of semantic file processing, split out of
 * `semanticFileProcessing.ts` to hold it under the size cap: whether an AI
 * provider is set up at all, and the summary/title/tags call. Node runtime:
 * the call runs the shared LLM dispatch.
 */

import type { z } from 'zod';
import type { ActionCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { LlmRootContext } from './llm/requestMeter';
import { resolveAiConfig, resolveLanguageModel } from './llmProvider';
import { AiNotConfiguredError } from './aiNotConfigured';
import { runLlmObject } from './llm/dispatch';
import { meterLlmCall } from '../analytics/meteredSpend';
import { logInfo } from './runtimeLog';
import { sendThroughBatch } from './llm/batch/submit';
import { summarySchema } from './semanticFileSummary';

/**
 * Whether any AI provider is set up. AI is optional: without one a file still
 * gets its extracted text, tags and search text, only no summary, embedding or
 * knowledge entries. A provider that is set up but unusable still throws, so a
 * misconfiguration stays visible instead of silently producing no vectors.
 */
export async function aiProviderConfigured(ctx: ActionCtx): Promise<boolean> {
	try {
		await resolveAiConfig(ctx);
		return true;
	} catch (error) {
		if (error instanceof AiNotConfiguredError) return false;
		throw error;
	}
}

interface SummaryInput {
	readonly file: Pick<Doc<'semanticFiles'>, 'filename' | 'mimeType'>;
	readonly fileCtx: { readonly threadSubject?: string | null; readonly contactNames: string[] };
	readonly textForAI: string;
	readonly root: LlmRootContext;
}

function summaryPrompt({ file, fileCtx, textForAI }: SummaryInput): string {
	return `Analyze this file and provide a title, summary, and tags.

Filename: ${file.filename}
MIME type: ${file.mimeType}${fileCtx.threadSubject ? `\nShared in conversation: "${fileCtx.threadSubject}"` : ''}${fileCtx.contactNames.length ? `\nRelated contacts: ${fileCtx.contactNames.join(', ')}` : ''}

Content:
${textForAI}`;
}

/**
 * L14: send the summary call through the provider's batch API when the
 * routing policy and the adapter allow it (`lib/llm/batch/submit.ts`). True:
 * it is out, and the file is processed again with the summary once it is
 * back. False: summarize in real time. Throws a spend refusal as the
 * real-time call would.
 */
export async function sendSummaryThroughBatch(
	ctx: ActionCtx,
	input: SummaryInput & { readonly fileId: Id<'semanticFiles'> }
): Promise<boolean> {
	const model = await resolveLanguageModel(ctx, 'file.summarize');
	return sendThroughBatch(ctx, {
		consumer: 'file_summary',
		sourceId: input.fileId,
		model,
		prompt: summaryPrompt(input),
		root: input.root,
	});
}

/** One metered summary call. Throws on failure (an admission refusal included). */
export async function summarizeFile(
	ctx: ActionCtx,
	input: SummaryInput
): Promise<z.infer<typeof summarySchema>> {
	const model = await resolveLanguageModel(ctx, 'file.summarize');
	const result = await meterLlmCall(ctx, { feature: 'semantic_file', root: input.root }, (meter) =>
		runLlmObject({
			meter,
			model,
			schema: summarySchema,
			prompt: summaryPrompt(input),
		})
	);
	logInfo('[semantic_file] llm call', {
		tokenUsage: result.tokenUsage,
		modelUsed: result.modelUsed,
	});
	return result.object;
}
