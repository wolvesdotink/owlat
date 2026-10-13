/**
 * Which pre-written reply a Reply Queue thread may show.
 *
 * Draft-on-arrival writes a reply into `needsReply.draftSlot` when a message
 * needs one. When the owner has to supply a fact first, the thread carries a
 * clarification instead, and its reply is written only after the answers (or
 * after "Draft with what I have") into `clarification.draft`. A slot next to a
 * clarification is never shown: it was written without those facts, so it
 * holds placeholders for exactly what the card is still asking (a slot stored
 * before this rule, or one from a run that raced the questions).
 *
 * Every read that shows the slot or says a draft is ready goes through
 * {@link visibleDraftSlot}. Pure, so both runtimes import it.
 */

interface SlotHolder<S> {
	draftSlot?: S | undefined;
	clarification?: unknown;
}

/** The arrival draft the thread may show, or undefined while a clarification owns the reply. */
export function visibleDraftSlot<S>(flag: SlotHolder<S> | undefined | null): S | undefined {
	if (!flag || flag.clarification) return undefined;
	return flag.draftSlot;
}

/** `thread` with a slot it may not show left out, for reads that return the whole row. */
export function withVisibleDraftSlot<
	T extends { needsReply?: (SlotHolder<unknown> & object) | undefined },
>(thread: T): T {
	const flag = thread.needsReply;
	if (!flag?.draftSlot || visibleDraftSlot(flag)) return thread;
	const { draftSlot: _hidden, ...rest } = flag;
	return { ...thread, needsReply: rest };
}
