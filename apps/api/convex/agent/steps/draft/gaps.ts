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
import { asTeamGapQuestion, checkDraftGaps } from '../../../mail/ai/gapQuestions';
import {
	buildFileAnswerNotes,
	buildOpenFileNote,
	buildOpenQuestionNote,
	joinConfirmedBlocks,
	openFileGaps,
	openQuestionGaps,
} from '../../../inbox/clarificationAnswers';
import { buildConfirmedContext } from '../../shared/draftService';
import { localizeQuestions } from '../../../inbox/clarificationLocalize';
import { resolveLanguageModel } from '../../../lib/llmProvider';
import { meterAgentCall } from '../../shared/agentSpend';
import { rethrowAdmissionRefusal } from '../../../analytics/backgroundDeferral';

type ClarificationQuestion = Infer<typeof clarificationQuestionValidator>;

/** What the stored clarification gives a draft, whichever path reached the step. */
export interface StoredClarificationDraft {
	/** The owner's answers and files, and each open question's placeholder under consent. */
	confirmedContext: string;
	/** The owner chose "Draft with what I have". */
	isGapsAccepted: boolean;
	/** The fixed placeholder of each question left open under that choice. */
	gapPlaceholders: string[];
}

/**
 * Rebuild the owner's answers, their consent to gaps and the placeholders that
 * consent requires from the message's stored `pendingClarification`. The draft
 * step reads it on every entry, not only after an answer: a draft that failed
 * after "Draft with what I have" is retried through the whole pipeline
 * (`retryFailedActions`), and the clarify step's direct hand-off carries none
 * of it. Without this, a retried draft that leaves an open detail out would
 * pass the gap check as complete.
 */
export function storedClarificationDraft(
	pending: { questions: ClarificationQuestion[]; isGapsAccepted?: boolean | undefined } | undefined
): StoredClarificationDraft {
	const questions = pending?.questions ?? [];
	const isGapsAccepted = pending?.isGapsAccepted === true;
	const fileGaps = isGapsAccepted ? openFileGaps(questions) : [];
	const questionGaps = isGapsAccepted ? openQuestionGaps(questions) : [];
	return {
		confirmedContext: joinConfirmedBlocks(
			buildConfirmedContext(pending),
			buildFileAnswerNotes(questions),
			buildOpenFileNote(fileGaps),
			buildOpenQuestionNote(questionGaps)
		),
		isGapsAccepted,
		gapPlaceholders: [...fileGaps, ...questionGaps],
	};
}

/** The `agentDecision` reason a draft held for an unaskable gap carries. */
export { UNASKABLE_GAP_REASON as DRAFT_HELD_REASON } from '../../../lib/heldGapDraft';

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
	let questions: ClarificationQuestion[] = gaps.questions.map(asTeamGapQuestion);
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
