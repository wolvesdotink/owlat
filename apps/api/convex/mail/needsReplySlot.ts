/**
 * Which pre-written reply a Reply Queue thread may show.
 *
 * Draft-on-arrival writes a reply into `needsReply.draftSlot` when a message
 * needs one. When the owner has to supply a fact first, the thread carries a
 * clarification instead, and its reply is written only after the answers (or
 * after "Draft with what I have") into `clarification.draft`. A reply with
 * gaps the owner did not agree to is never shown:
 *
 *  - a slot next to a clarification: it was written without those facts, so
 *    it holds placeholders for exactly what the card is still asking (a slot
 *    stored before this rule, or one from a run that raced the questions);
 *  - a slot with a gap of its own (stored before the writers checked);
 *  - a clarification reply with a gap the owner did not agree to: the card
 *    reads as asking again, with every answer kept, so it can be drafted anew.
 *
 * The writers hold such drafts back already; this is the read side, for rows
 * stored before them. Every read that shows a reply or says one is ready goes
 * through here. Pure, so both runtimes import it.
 */

import { authoredDraftHasGaps } from '../agent/shared/draftGaps';
import { hasUsableAnswer } from '../inbox/clarificationAnswers';

interface ClarificationLike {
	questions: ReadonlyArray<Parameters<typeof hasUsableAnswer>[0]>;
	answeredAt?: number | undefined;
	isNeeded: boolean;
	isGapsAccepted?: boolean | undefined;
	draft?: string | undefined;
}

interface SlotHolder<S extends { draft: string }, C extends ClarificationLike> {
	draftSlot?: S | undefined;
	clarification?: C | undefined;
}

/**
 * Whether the owner agreed to a draft with gaps: "Draft with what I have", or
 * a card answered with questions left open, which only that choice allows
 * now (and which the card's own copy offered as gaps before it existed).
 */
export function isGapsAccepted(clarification: ClarificationLike): boolean {
	return clarification.isGapsAccepted === true || !clarification.questions.every(hasUsableAnswer);
}

/** The arrival draft the thread may show, or undefined (see the module comment). */
export function visibleDraftSlot<S extends { draft: string }, C extends ClarificationLike>(
	flag: SlotHolder<S, C> | undefined | null
): S | undefined {
	if (!flag?.draftSlot || flag.clarification) return undefined;
	return authoredDraftHasGaps({ text: flag.draftSlot.draft }) ? undefined : flag.draftSlot;
}

/** The clarification as the card may show it: a reply with unagreed gaps reads as asking again. */
export function visibleClarification<C extends ClarificationLike>(clarification: C): C {
	const draft = clarification.draft;
	if (!draft || isGapsAccepted(clarification) || !authoredDraftHasGaps({ text: draft })) {
		return clarification;
	}
	const { draft: _held, answeredAt: _answered, ...asking } = clarification;
	return { ...asking, isNeeded: true } as C;
}

/** `thread` as a whole row may be shown: a hidden slot left out, the clarification as the card shows it. */
export function withVisibleDrafts<
	T extends {
		needsReply?:
			| (SlotHolder<{ draft: string }, ClarificationLike> & Record<string, unknown>)
			| undefined;
	},
>(thread: T): T {
	const flag = thread.needsReply;
	if (!flag) return thread;
	const { draftSlot, clarification, ...rest } = flag;
	const slot = visibleDraftSlot(flag);
	return {
		...thread,
		needsReply: {
			...rest,
			...(slot ? { draftSlot } : {}),
			...(clarification ? { clarification: visibleClarification(clarification) } : {}),
		},
	};
}
