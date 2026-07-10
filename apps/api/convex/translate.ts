'use node';

import { v } from 'convex/values';
import { z } from 'zod';
import { authedAction } from './lib/authedFunctions';
import { logInfo } from './lib/runtimeLog';
import { runLlmObject } from './lib/llm/dispatch';
import { recordLlmSpend } from './analytics/llmUsage';
import { resolveLanguageModel } from './lib/llmProvider';
import { requireAuthenticatedIdentity } from './lib/sessionOrganization';

interface TranslationItem {
	id: string;
	text: string;
	isHtml: boolean;
}

interface TranslatedItem {
	id: string;
	translatedText: string;
}

// Schema-constrained translation result. `index` ties each translation back to
// the input item's position (and thus its id). runLlmObject (generateObject)
// enforces this shape, so a malformed model response surfaces as a thrown error
// rather than being silently sliced/parsed into `[]`.
const translationSchema = z.object({
	translations: z.array(
		z.object({
			index: z.number().int().describe('Zero-based index of the input item this translates'),
			translatedText: z.string().describe('The translated text content'),
		})
	),
});

/**
 * Translate a batch of items from one language to another using AI
 */
// all-members: content translation utility available to any authenticated member.
export const translateBatch = authedAction({
	args: {
		items: v.array(
			v.object({
				id: v.string(),
				text: v.string(),
				isHtml: v.boolean(),
			})
		),
		sourceLanguage: v.string(),
		targetLanguage: v.string(),
	},
	handler: async (ctx, args): Promise<{ translations: TranslatedItem[] }> => {
		// Require authentication to prevent unauthorized API quota consumption
		await requireAuthenticatedIdentity(ctx);

		const { items, sourceLanguage, targetLanguage } = args;

		// Build the translation prompt
		const prompt = buildTranslationPrompt(items, sourceLanguage, targetLanguage);

		// Call the AI model with a schema-constrained object response (ADR-029
		// dispatch). generateObject validates the shape, so a malformed response
		// throws through runLlmObject's normal path instead of silently yielding
		// zero translations the way the old fence-stripping parser did.
		const { object, tokenUsage, modelUsed } = await runLlmObject({
			model: await resolveLanguageModel(ctx, 'summarize'), // Translation is a fast-tier task
			schema: translationSchema,
			prompt,
			temperature: 0.3,
		});
		logInfo('[translate] llm call', { tokenUsage, modelUsed });
		await recordLlmSpend(ctx, 'translate', tokenUsage, modelUsed);

		// Map each translation back to its original item id via the index.
		const translations: TranslatedItem[] = object.translations.map((t) => ({
			id: items[t.index]?.id ?? String(t.index),
			translatedText: t.translatedText,
		}));

		return { translations };
	},
});

function buildTranslationPrompt(
	items: TranslationItem[],
	sourceLanguage: string,
	targetLanguage: string
): string {
	const itemsJson = items.map((item, index) => ({
		index,
		id: item.id,
		text: item.text,
		isHtml: item.isHtml,
	}));

	return `You are a professional translator. Translate the following items from ${sourceLanguage} to ${targetLanguage}.

INPUT (JSON array):
${JSON.stringify(itemsJson, null, 2)}

Return one entry per input item under "translations", each with the item's "index" and its "translatedText".

Important:
- Preserve HTML tags exactly as they are (do not translate tag names or attributes)
- Preserve template variables like {{variableName}} exactly as they are
- Maintain the same formatting and line breaks
- Only translate the actual text content`;
}
