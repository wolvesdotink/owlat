'use node';

/**
 * No team draft with silent gaps: the Team inbox side of
 * `mail/ai/gapQuestions.ts`.
 *
 * The `clarify` step does not always ask before the draft is written: coverage
 * is high, the judge finds nothing, the eagerness cap drops a question, or the
 * step fails soft. The drafter may then write its own `[[...]]` placeholders
 * (agent/shared/draftGaps.ts). Without the owner's consent ("Draft with what I
 * have", or asking turned off) such a draft is not stored or shown: each gap
 * becomes a question on the message, which goes back to
 * `awaiting_clarification`. A gap only a question Owlat never asks could fill
 * (a password) leaves the message for a person to write, with no AI draft.
 */

import type { Infer } from 'convex/values';
import type { ActionCtx } from '../../../_generated/server';
import type { Id } from '../../../_generated/dataModel';
import type { clarificationQuestionValidator } from '../../../lib/validators/clarification';
import { checkDraftGaps } from '../../../mail/ai/gapQuestions';
import { localizeQuestions } from '../../../inbox/clarificationLocalize';
import { resolveLanguageModel } from '../../../lib/llmProvider';
import { meterAgentCall } from '../../shared/agentSpend';
import { rethrowAdmissionRefusal } from '../../../analytics/backgroundDeferral';

type ClarificationQuestion = Infer<typeof clarificationQuestionValidator>;

/** The `agentDecision` reason a draft held for an unaskable gap carries. */
export const DRAFT_HELD_REASON =
	'This reply needs a detail Owlat never asks for, such as a password, so there is no AI draft. Write it yourself.';

/** What a team draft still needs before it may be stored. */
export type TeamDraftGapCheck =
	| { kind: 'complete' }
	/** The questions to park the message on: the ones it had, then one per gap. */
	| { kind: 'ask'; questions: ClarificationQuestion[] }
	| { kind: 'unaskable' };

/**
 * Check a freshly written team draft for gaps the owner did not agree to.
 * The gap questions are attributed to the sender, filtered like every other
 * generated question, and translated into the interface languages (English
 * too: the model wrote the labels in the reply's language). A translation
 * failure keeps the labels as written.
 */
export async function checkTeamDraftGaps(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>,
	draft: string,
	message: {
		from?: string | undefined;
		pendingClarification?: { questions: ClarificationQuestion[] } | undefined;
	} | null
): Promise<TeamDraftGapCheck> {
	const existing = message?.pendingClarification?.questions ?? [];
	const gaps = checkDraftGaps(draft, { fromAddress: message?.from ?? '', existing });
	if (gaps.kind !== 'ask') return gaps;
	// The Reply Queue shape carries `origin`; the team question has no such field.
	let questions: ClarificationQuestion[] = gaps.questions.map((q) => ({
		id: q.id,
		slotType: q.slotType,
		text: q.text,
		...(q.answerKind ? { answerKind: q.answerKind } : {}),
		...(q.options && q.options.length > 0 ? { options: q.options } : {}),
	}));
	try {
		const model = await resolveLanguageModel(ctx, 'mail.clarify');
		const localized = await meterAgentCall(ctx, 'agent_clarify', inboundMessageId, (meter) =>
			localizeQuestions(model, questions, undefined, meter, { includeCanonical: true })
		);
		questions = localized.questions;
	} catch (error) {
		rethrowAdmissionRefusal(error);
	}
	return { kind: 'ask', questions: [...existing, ...questions] };
}
