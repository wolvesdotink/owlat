/**
 * No draft with silent gaps: a reply the AI wrote is only shown once the owner
 * has given every fact it needs, or has chosen "Draft with what I have".
 *
 * Every drafter is told to write `[[what is missing]]` where it lacks a fact
 * (agent/shared/draftGaps.ts), and the questions asked before drafting do not
 * always catch every such fact: a check stage can fail and ask nothing, the
 * eagerness cap drops a question, or the model finds a gap of its own. A draft
 * that comes back with placeholders the owner never agreed to is therefore
 * held, and each placeholder becomes a question on the same card the asking
 * drafter uses. Answering them writes the draft again with those facts. A gap
 * only a question Owlat never asks could fill (a password) holds the draft
 * without a question: there is no AI draft for that reply.
 *
 * Shared by the Reply Queue (draft-on-arrival and the draft after the owner's
 * answers, in their actions and again where they store) and Answer mode's
 * "Draft with AI". Pure (no ctx, no 'use node').
 */

import { authoredGapLabels } from '../../agent/shared/draftGaps';
import { withAnswerKind } from '../../inbox/clarificationAnswers';
import { sanitizeClarificationQuestions } from '../../inbox/clarificationSlots';
import type { Id } from '../../_generated/dataModel';
import type { AskQuestion } from './composeDraftPolicy';

/** Ids of the questions a held draft's placeholders become. */
export const GAP_QUESTION_PREFIX = 'gap_';

/**
 * A gap that asks for a file to be attached: it opens with the verb ("attach
 * the September invoice") or, in German, ends with it ("Rechnung als PDF
 * anhängen"). A gap that only mentions a file ("amount in the attached
 * invoice", "maximum file size") asks for a fact and stays a text question.
 */
const FILE_GAP =
	/^(?:please\s+|bitte\s+)?(?:attach|enclose|upload|anh(?:ä|ae)ngen|beif(?:ü|ue)gen|beilegen|hochladen)\b|\b(?:anh(?:ä|ae)ngen|beif(?:ü|ue)gen|beilegen|hochladen|mitschicken)$/iu;

/** What a freshly written draft still needs before it may be shown. */
export type DraftGapCheck =
	| { kind: 'complete' }
	/** One question per gap, for the owner to answer before the draft is written again. */
	| { kind: 'ask'; questions: AskQuestion[] }
	/** Gaps only a question Owlat never asks (a password, a code) could fill. */
	| { kind: 'unaskable' };

/**
 * Check `draft` for gaps and turn them into questions, attributed to the email
 * they came from and filtered like every other generated question (a
 * credential solicitation never reaches the card). A gap that asks for a file
 * gets the file input. Ids continue after the ones `existing` already uses.
 */
export function checkDraftGaps(
	draft: string,
	opts: { fromAddress: string; existing: readonly { id: string }[] }
): DraftGapCheck {
	const labels = authoredGapLabels(draft);
	if (labels.length === 0) return { kind: 'complete' };
	const taken = new Set(opts.existing.map((q) => q.id));
	let next = 0;
	const freshId = () => {
		while (taken.has(`${GAP_QUESTION_PREFIX}${next}`)) next += 1;
		const id = `${GAP_QUESTION_PREFIX}${next}`;
		taken.add(id);
		return id;
	};
	const questions = sanitizeClarificationQuestions<Id<'threadItems'>>(
		labels.map((label) => ({
			slotType: FILE_GAP.test(label) ? 'attachment' : 'factual_lookup',
			text: label,
		})),
		opts.fromAddress
	).map((question) => withAnswerKind({ ...question, id: freshId() }));
	return questions.length > 0 ? { kind: 'ask', questions } : { kind: 'unaskable' };
}

/**
 * A gap question in the Team inbox's `pendingClarification` shape, which has
 * no `origin`: the card names the sender from the message itself.
 */
export function asTeamGapQuestion(question: AskQuestion) {
	return {
		id: question.id,
		slotType: question.slotType,
		text: question.text,
		...(question.answerKind ? { answerKind: question.answerKind } : {}),
		...(question.options && question.options.length > 0 ? { options: question.options } : {}),
	};
}
