'use node';

/**
 * Shared reply-options generator.
 *
 * ONE place that turns a prompt into up-to-3 distinct, ready-to-send reply
 * variants via the capable-tier `runLlmObject` seam. Used by BOTH:
 *   - the Postbox composer's `suggestReplies` (mail/ai.ts), and
 *   - the inbound agent's `draft` step (agent/steps/draft), which offers the
 *     reviewer 2–3 pickable drafts on low-confidence / low-quality cases.
 *
 * The schema + model tier + slice cap live here so the two callers cannot drift
 * apart (the spec's "share the generator, do not fork"). Callers own their own
 * prompt framing (the inbound thread body is untrusted DATA in both) and their
 * own spend accounting.
 */

import { z } from 'zod';
import type { ActionCtx } from '../_generated/server';
import { resolveLanguageModel } from '../lib/llmProvider';
import { runLlmObject } from '../lib/llm/dispatch';
import type { TokenUsage } from '../agent/steps/types';

/** Hard cap on how many reply variants we ever surface. */
export const MAX_REPLY_OPTIONS = 3;

/** Structured output: up to {@link MAX_REPLY_OPTIONS} short reply variants. */
export const replyOptionsSchema = z.object({
	replies: z.array(z.string()).max(MAX_REPLY_OPTIONS),
});

/**
 * Run one capable-tier `runLlmObject` pass that returns up to
 * {@link MAX_REPLY_OPTIONS} distinct reply variants for the given prompt.
 * Returns the trimmed replies plus the token usage + model id so the caller can
 * record spend under its own event name. Does NOT record spend or catch errors
 * itself — the caller decides fail-soft behaviour.
 */
export async function generateReplyOptions(
	ctx: ActionCtx,
	args: {
		prompt: string;
		temperature?: number;
	}
): Promise<{
	replies: string[];
	tokenUsage: TokenUsage | undefined;
	modelUsed: string | undefined;
}> {
	const { object, tokenUsage, modelUsed } = await runLlmObject({
		model: await resolveLanguageModel(ctx, 'draft'),
		schema: replyOptionsSchema,
		prompt: args.prompt,
		temperature: args.temperature ?? 0.7,
	});
	return {
		replies: object.replies.slice(0, MAX_REPLY_OPTIONS),
		tokenUsage,
		modelUsed,
	};
}
