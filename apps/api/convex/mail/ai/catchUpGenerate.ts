'use node';

/**
 * The model call behind Answer mode's catch-up card, shared by the Postbox
 * action (mail/ai/catchUp.ts) and the team one (inbox/catchUp.ts). Callers own
 * the reader check, the cache and the card's AI gate. It talks to the model,
 * records spend and cleans the output. The asks' coverage check is gone: the
 * draft's response plan replaces it (mail/interpret/coverage.ts).
 *
 * It runs on the cheap `summarize` tier with the interactive deadline and
 * fails soft: any dispatch error comes back as null, never as an exception the
 * page has to catch.
 */

import type { ActionCtx } from '../../_generated/server';
import type { AppLocale } from '@owlat/shared/appLocales';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmObject } from '../../lib/llm/dispatch';
import { interactiveLlmPolicy } from '../../lib/llm/retryPolicy';
import { scheduleLlmSpend } from '../../analytics/llmUsage';
import { recordSpendOnFailure } from '../../analytics/failedLlmSpend';
import { THREAD_SUMMARY } from './transcript';
import {
	assembleCatchUpTranscript,
	buildCatchUpPrompt,
	catchUpModelSchema,
	sanitizeCatchUp,
	type CatchUp,
	type CatchUpEntry,
	type CatchUpMode,
} from './catchUpPrompt';

/**
 * One structured call over the thread, within the summary strip's transcript
 * budget. Null when the model is unavailable or fails, so nothing is cached and
 * the next open tries again.
 */
export async function generateCatchUp(
	ctx: ActionCtx,
	input: { entries: CatchUpEntry[]; mode: CatchUpMode; locale: AppLocale; feature: string }
): Promise<Pick<CatchUp, 'sentences' | 'asks'> | null> {
	if (input.entries.length === 0) return null;
	const { transcript, kept } = assembleCatchUpTranscript(input.entries, THREAD_SUMMARY.totalChars);
	try {
		const { object, tokenUsage, modelUsed } = await recordSpendOnFailure(
			ctx,
			input.feature,
			runLlmObject({
				model: await resolveLanguageModel(ctx, 'summarize'),
				schema: catchUpModelSchema,
				prompt: buildCatchUpPrompt({ transcript, mode: input.mode, locale: input.locale }),
				temperature: 0.2,
				...interactiveLlmPolicy('reply'),
			}),
			scheduleLlmSpend
		);
		await scheduleLlmSpend(ctx, input.feature, tokenUsage, modelUsed);
		return sanitizeCatchUp(object, kept, input.mode);
	} catch {
		return null;
	}
}
