'use node';

/**
 * The model-facing parts of semantic file processing, split out of
 * `semanticFileProcessing.ts` to hold it under the size cap: whether an AI
 * provider is set up at all, and the summary/title/tags call. Node runtime:
 * the call runs the shared LLM dispatch.
 */

import { z } from 'zod';
import type { ActionCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import type { LlmRootContext } from './llm/requestMeter';
import { resolveAiConfig, resolveLanguageModel } from './llmProvider';
import { AiNotConfiguredError } from './aiNotConfigured';
import { runLlmObject } from './llm/dispatch';
import { meterLlmCall } from '../analytics/meteredSpend';
import { logInfo } from './runtimeLog';

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

const summarySchema = z.object({
	title: z.string().describe('Short descriptive title for the file'),
	summary: z.string().describe('2-3 sentence summary of the file content'),
	tags: z.array(z.string()).describe('5-10 relevant tags for categorization'),
});

/** One metered summary call. Throws on failure (an admission refusal included). */
export async function summarizeFile(
	ctx: ActionCtx,
	input: {
		readonly file: Pick<Doc<'semanticFiles'>, 'filename' | 'mimeType'>;
		readonly fileCtx: { readonly threadSubject?: string | null; readonly contactNames: string[] };
		readonly textForAI: string;
		readonly root: LlmRootContext;
	}
): Promise<z.infer<typeof summarySchema>> {
	const { file, fileCtx, textForAI } = input;
	const model = await resolveLanguageModel(ctx, 'summarize');
	const result = await meterLlmCall(ctx, { feature: 'semantic_file', root: input.root }, (meter) =>
		runLlmObject({
			meter,
			model,
			schema: summarySchema,
			prompt: `Analyze this file and provide a title, summary, and tags.

Filename: ${file.filename}
MIME type: ${file.mimeType}${fileCtx.threadSubject ? `\nShared in conversation: "${fileCtx.threadSubject}"` : ''}${fileCtx.contactNames.length ? `\nRelated contacts: ${fileCtx.contactNames.join(', ')}` : ''}

Content:
${textForAI}`,
		})
	);
	logInfo('[semantic_file] llm call', {
		tokenUsage: result.tokenUsage,
		modelUsed: result.modelUsed,
	});
	return result.object;
}
