/**
 * The contract between the Answer queue's flow and the card it is showing.
 *
 * A card owns its own actions (reply, approve, snooze…) and reports back
 * through these controls; the flow owns position, undo and the end state.
 * Keeps each card free of the flow's bookkeeping and lets one flow host every
 * source (Postbox mail, team-inbox drafts, chat mentions).
 */
import type { TaskFlowKind } from './taskFlow';
import type { ReplyQueueItem } from './postboxReplyQueue';
import { replyQueueSection } from './postboxReplyQueue';

export interface AnswerCardControls {
	/** Finish the card with an outcome (tallied); `inverse` makes it undoable. */
	complete(outcome: string, inverse?: () => Promise<void> | void): void;
	/** Move past the card without an outcome (it left the queue elsewhere). */
	skip(): void;
	/** Undo THIS card's completion (the approve toast's own Undo). */
	undoSelf(): void;
	back(): void;
	next(): void;
}

/** The flow kind of a Postbox reply-queue row (drives ordering + card). */
export function mailAnswerKind(
	row: Pick<ReplyQueueItem, 'clarification' | 'kind' | 'draftSlot'>
): TaskFlowKind {
	if (replyQueueSection(row) === 'needs_input') return 'question';
	if (row.kind !== 'followup' && row.draftSlot) return 'draft_review';
	return 'reply';
}
