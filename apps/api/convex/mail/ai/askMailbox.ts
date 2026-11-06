'use node';

/**
 * Ask your mailbox: answer a question from the caller's own mail, citing the
 * messages the answer used. The command palette's `?` in Postbox calls
 * {@link askMailbox}; the assistant's `askMailbox` tool calls
 * {@link answerFromMail} with the mail its turn's user may read.
 *
 * Which mail is read is decided by `./askMailboxSearch`, the prompt and the
 * citations by `./askMailboxText`. Mail is attacker-controlled text: it is
 * injection-scrubbed by the search and quoted inside a fence the prompt tells
 * the model to treat as data. Advisory: the answer is shown, never acted on.
 */

import { v } from 'convex/values';
import { authedAction } from '../../lib/authedFunctions';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmText } from '../../lib/llm/dispatch';
import { interactiveLlmPolicy } from '../../lib/llm/retryPolicy';
import { meterLlmCall, type MeterLlmCallOptions } from '../../analytics/meteredSpend';
import { newRootRequest, type LlmRootContext } from '../../lib/llm/requestMeter';
import { anchorActionDeadline } from '../../lib/llm/actionDeadline';
import { throwInvalidInput } from '../../_utils/errors';
import { gatedInParallel } from './gate';
import {
	MAX_ASK_MAILBOX_QUESTION_CHARS,
	buildAskMailboxPrompt,
	citationsFromAnswer,
	type AskMailboxAnswer,
	type AskMailboxSearchResult,
} from './askMailboxText';

/** The spend tag both entry points record under. */
export const ASK_MAILBOX_SPEND = 'postbox_ask_mailbox' as const;

/**
 * Answer `question` from `found`. No match means no model call and an empty
 * answer, so a question about mail the reader does not have costs nothing.
 */
export async function answerFromMail(
	ctx: ActionCtx,
	args: {
		question: string;
		found: AskMailboxSearchResult;
		root?: LlmRootContext;
		abortSignal?: AbortSignal;
		meterOptions?: MeterLlmCallOptions;
	}
): Promise<AskMailboxAnswer> {
	const { sources, bodySearchUsed } = args.found;
	if (sources.length === 0) {
		return { answer: '', citations: [], bodySearchUsed, isTruncated: false };
	}
	const model = await resolveLanguageModel(ctx, 'mail.ask');
	const { system, prompt } = buildAskMailboxPrompt({ question: args.question, sources });
	const { text, isTruncated } = await meterLlmCall(
		ctx,
		{ feature: ASK_MAILBOX_SPEND, ...(args.root ? { root: args.root } : {}) },
		(meter) =>
			runLlmText({
				meter,
				model,
				system,
				prompt,
				temperature: 0.2,
				...interactiveLlmPolicy('reply'),
				...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
			}),
		args.meterOptions
	);
	const answer = text.trim();
	return {
		answer,
		citations: citationsFromAnswer(answer, sources),
		bodySearchUsed,
		isTruncated: isTruncated === true,
	};
}

/**
 * The palette's `?` in Postbox. `bodySearchUsed: false` tells the reader the
 * answer saw headers and snippets only; `answer: ''` that no message matched.
 */
// authz: org membership enforced by authedAction; which mailboxes are read is
// decided by mail.ai.askMailboxSearch.searchAsCaller from the caller's own
// session (owner for a personal mailbox, membership for a team inbox); the `ai`
// flag, spend admission and the per-user rate limit by gate.assertAiAllowed.
export const askMailbox = authedAction({
	args: { question: v.string() },
	handler: async (ctx, args): Promise<AskMailboxAnswer> => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		const question = args.question.trim().slice(0, MAX_ASK_MAILBOX_QUESTION_CHARS);
		if (!question) throwInvalidInput('Ask a question');
		// The model is resolved only once something matched, so a question no
		// message answers works on an instance without a model provider too.
		const found = await gatedInParallel(
			ctx,
			ctx.runQuery(internal.mail.ai.askMailboxSearch.searchAsCaller, { question }),
			{ rateLimitBucket: 'askMailboxPerUser' }
		);
		return answerFromMail(ctx, {
			question,
			found,
			root: newRootRequest('postbox_action'),
			meterOptions: { write: 'schedule', rethrow: 'as_is' },
		});
	},
});
