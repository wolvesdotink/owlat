'use node';

/**
 * R2's model call when the delivered message has pending rule questions
 * (SPEC §6.2, `mail/arrival/r2.ts`), split out of `categoryClassify.ts` at
 * the size cap. One call answers the questions from this message's scoped
 * text and, when the thread category is still unresolved, the category too.
 *
 * Behind the same gate as the plain refinement (the `ai` flag and the owner's
 * background rate limit, #1380) and metered as `postbox_category`. A budget
 * refusal is rethrown so the action defers (D1); a rate-limit refusal comes
 * back as `rateLimited` for the caller's bounded retry; anything else leaves
 * every question unanswered, which counts as no match.
 */

import { z } from 'zod';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmObject } from '../../lib/llm/dispatch';
import { meterLlmCall } from '../../analytics/meteredSpend';
import type { LlmRootContext } from '../../lib/llm/requestMeter';
import { rethrowAdmissionRefusal } from '../../analytics/backgroundDeferral';
import type { ArrivalAiAnswer, PendingAiFilter } from '../arrival/hooks';
import {
	answersOf,
	r2AnswersSchema,
	R2_MESSAGE_CHARS,
	r2QuestionsPrompt,
	unansweredOf,
} from '../arrival/r2';
import { buildScopedMessageInput } from '../arrival/scopedInput';
import { rateLimitRefusalOf } from './gate';
import type { MailCategory } from '../category';

export type CategoryQuestionsOutcome =
	| { kind: 'answered'; answers: ArrivalAiAnswer[]; category?: MailCategory }
	| { kind: 'rateLimited'; retryAfter?: number };

/**
 * Ask this message's questions (and the category, given its prompt). Never
 * throws but for a budget refusal.
 */
export async function askCategoryQuestions(
	ctx: ActionCtx,
	args: {
		messageId: Id<'mailMessages'>;
		questions: readonly PendingAiFilter[];
		ownerUserId: string;
		root: LlmRootContext;
		/** The category prompt and its enum, when the category is unresolved. */
		category?: { prompt: string; field: z.ZodType<MailCategory> };
		/** The caller already passed the gate for this call. */
		isGateChecked?: boolean;
	}
): Promise<CategoryQuestionsOutcome> {
	try {
		if (!args.isGateChecked) {
			await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {
				ownerUserId: args.ownerUserId,
			});
		}
		const input = await buildScopedMessageInput(ctx, args.messageId, {
			maxChars: R2_MESSAGE_CHARS,
		});
		// Nothing a short read may see (security mail, exact wording, fenced, gone).
		if (!input && !args.category) {
			return { kind: 'answered', answers: unansweredOf(args.questions) };
		}
		const questionsPart = input ? r2QuestionsPrompt(args.questions, input) : '';
		const schema = args.category
			? z.object({ category: args.category.field, answers: r2AnswersSchema })
			: z.object({ answers: r2AnswersSchema });
		const model = await resolveLanguageModel(ctx, 'mail.classify');
		const { object } = await meterLlmCall(
			ctx,
			{ feature: 'postbox_category', root: args.root },
			(meter) =>
				runLlmObject({
					meter,
					model,
					schema,
					prompt: [args.category?.prompt, questionsPart].filter(Boolean).join('\n\n'),
					temperature: 0,
				})
		);
		const parsed = object as { category?: MailCategory; answers?: z.infer<typeof r2AnswersSchema> };
		return {
			kind: 'answered',
			answers: input ? answersOf(args.questions, parsed.answers) : unansweredOf(args.questions),
			...(parsed.category ? { category: parsed.category } : {}),
		};
	} catch (error) {
		rethrowAdmissionRefusal(error);
		const limited = rateLimitRefusalOf(error);
		if (limited) return { kind: 'rateLimited', ...limited };
		return { kind: 'answered', answers: unansweredOf(args.questions) };
	}
}
