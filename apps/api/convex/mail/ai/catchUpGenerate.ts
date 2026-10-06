'use node';

/**
 * The two model calls behind Answer mode's catch-up card, shared by the Postbox
 * actions (mail/ai/catchUp.ts) and the team ones (inbox/catchUp.ts). Callers
 * own the reader check and the cache, and the card's AI gate; the coverage
 * check charges its own gate bucket. These talk to the model, record spend and
 * clean the output.
 *
 * Both run on the cheap `summarize` tier with the interactive deadline, and
 * both fail soft: any dispatch error comes back as null (card) or no ticks
 * (coverage), never as an exception the page has to catch.
 */

import { internal } from '../../_generated/api';
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
	buildCoveragePrompt,
	catchUpModelSchema,
	coverageModelSchema,
	sanitizeCatchUp,
	sanitizeCoverage,
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

/**
 * Which of the card's asks the draft addresses. Nothing to check (no asks, an
 * empty draft) costs nothing. The gate charges its own rate bucket, since the
 * composer calls this while the user types, and a refusal (budget spent,
 * bucket empty, AI off) just leaves the asks unticked: the ticks are a hint.
 */
export async function checkAskCoverage(
	ctx: ActionCtx,
	input: { asks: CatchUp['asks']; draftText: string; feature: string }
): Promise<string[]> {
	if (input.asks.length === 0 || !input.draftText.trim()) return [];
	try {
		await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {
			rateLimitBucket: 'answerCoveragePerUser',
		});
		const { object, tokenUsage, modelUsed } = await recordSpendOnFailure(
			ctx,
			input.feature,
			runLlmObject({
				model: await resolveLanguageModel(ctx, 'summarize'),
				schema: coverageModelSchema,
				prompt: buildCoveragePrompt({ asks: input.asks, draftText: input.draftText }),
				temperature: 0,
				...interactiveLlmPolicy('reply'),
			}),
			scheduleLlmSpend
		);
		await scheduleLlmSpend(ctx, input.feature, tokenUsage, modelUsed);
		return sanitizeCoverage(object, input.asks);
	} catch {
		return [];
	}
}
