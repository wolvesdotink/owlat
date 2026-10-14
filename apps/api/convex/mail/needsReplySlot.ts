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
import { isFencedThread } from './interpret/staleFence';

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
 * now (and which the card's own copy offered as gaps before it existed). A
 * card still asking agreed to nothing.
 */
export function isGapsAccepted(clarification: ClarificationLike): boolean {
	if (clarification.isGapsAccepted === true) return true;
	return clarification.answeredAt !== undefined && !clarification.questions.every(hasUsableAnswer);
}

/** The arrival draft the thread may show, or undefined (see the module comment). */
export function visibleDraftSlot<S extends { draft: string }, C extends ClarificationLike>(
	flag: SlotHolder<S, C> | undefined | null
): S | undefined {
	if (!flag?.draftSlot || flag.clarification) return undefined;
	return authoredDraftHasGaps({ text: flag.draftSlot.draft }) ? undefined : flag.draftSlot;
}

/**
 * The arrival draft a thread may show: none while its interpretation is fenced
 * off (interpret/staleFence.ts), whose plan the draft was written from.
 */
export function visibleThreadDraftSlot<S extends { draft: string }, C extends ClarificationLike>(
	thread: {
		needsReply?: SlotHolder<S, C> | undefined | null;
		interpretationStaleSince?: number | undefined;
	} | null
): S | undefined {
	return thread && !isFencedThread(thread) ? visibleDraftSlot(thread.needsReply) : undefined;
}

/**
 * The clarification a thread may show (as the card shows it): without the
 * AI-written draft while the thread's interpretation is fenced off
 * (interpret/staleFence.ts), the questions and the person's answers kept.
 */
export function visibleThreadClarification<C extends ClarificationLike>(thread: {
	needsReply?: { clarification?: C | undefined } | undefined | null;
	interpretationStaleSince?: number | undefined;
}): C | undefined {
	const clarification = thread.needsReply?.clarification;
	if (!clarification) return undefined;
	const shown = visibleClarification(clarification);
	if (!isFencedThread(thread) || shown.draft === undefined) return shown;
	const { draft: _ai, ...answered } = shown;
	return answered as C;
}

/**
 * The clarification as the card may show it: a reply on a card still asking
 * is not shown (it raced the questions), and one with gaps the owner did not
 * agree to reads as asking again.
 */
export function visibleClarification<C extends ClarificationLike>(clarification: C): C {
	const draft = clarification.draft;
	if (draft && clarification.answeredAt === undefined) {
		const { draft: _raced, ...asking } = clarification;
		return asking as C;
	}
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
		interpretationStaleSince?: number | undefined;
	},
>(thread: T): T {
	const flag = thread.needsReply;
	if (!flag) return thread;
	const { draftSlot, clarification, ...rest } = flag;
	const slot = visibleThreadDraftSlot(thread);
	return {
		...thread,
		needsReply: {
			...rest,
			...(slot ? { draftSlot } : {}),
			...(clarification ? { clarification: visibleThreadClarification(thread)! } : {}),
		},
	};
}
