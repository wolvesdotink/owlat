'use node';

/**
 * R2's model call when the delivered message has pending rule questions
 * (SPEC §6.2, `mail/arrival/r2.ts`), split out of `categoryClassify.ts` at
 * the size cap. One call answers the questions from this message's scoped
 * text, the cold-pitch question when the sender is a candidate (#1381,
 * `mail/arrival/coldPitch.ts`) and, when the thread category is still
 * unresolved, the category too.
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
	isColdPitchAnswer,
	r2AnswersSchema,
	r2ColdPitchSchema,
	R2_MESSAGE_CHARS,
	r2QuestionsPrompt,
	unansweredOf,
} from '../arrival/r2';
import { buildScopedMessageInput } from '../arrival/scopedInput';
import { rateLimitRefusalOf } from './gate';
import type { MailCategory } from '../category';

export type CategoryQuestionsOutcome =
	| {
			kind: 'answered';
			answers: ArrivalAiAnswer[];
			category?: MailCategory;
			/**
			 * The model said yes to the cold-pitch question (asked only for a
			 * candidate): the body fingerprint of the text it read, which the
			 * commit rechecks.
			 */
			coldPitchSourceVersion?: string;
	  }
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
		/** Also ask the cold-pitch question (#1381); the caller checked the candidate. */
		isColdPitchAsked?: boolean;
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
		// The cold-pitch question needs the message's own text, like the rule
		// questions, and its fingerprint, so a stale yes cannot commit.
		const coldPitchVersion = args.isColdPitchAsked === true ? input?.sourceVersion : undefined;
		const isColdPitchAsked = coldPitchVersion !== undefined;
		const questionsPart = input
			? r2QuestionsPrompt(args.questions, input, { isColdPitchAsked })
			: '';
		const schema = z.object({
			...(args.category ? { category: args.category.field } : {}),
			...(args.questions.length > 0 ? { answers: r2AnswersSchema } : {}),
			...(isColdPitchAsked ? { coldPitch: r2ColdPitchSchema } : {}),
		});
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
		const parsed = object as {
			category?: MailCategory;
			answers?: z.infer<typeof r2AnswersSchema>;
			coldPitch?: z.infer<typeof r2ColdPitchSchema>;
		};
		return {
			kind: 'answered',
			answers: input ? answersOf(args.questions, parsed.answers) : unansweredOf(args.questions),
			...(parsed.category ? { category: parsed.category } : {}),
			...(coldPitchVersion !== undefined && isColdPitchAnswer(parsed.coldPitch)
				? { coldPitchSourceVersion: coldPitchVersion }
				: {}),
		};
	} catch (error) {
		rethrowAdmissionRefusal(error);
		const limited = rateLimitRefusalOf(error);
		if (limited) return { kind: 'rateLimited', ...limited };
		return { kind: 'answered', answers: unansweredOf(args.questions) };
	}
}
