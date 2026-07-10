/**
 * Team-inbox collision safety: the stale-reply guard.
 *
 * A shared (team) inbox has one shared read state, so two teammates can open
 * the same thread and both start replying. Without presence infrastructure we
 * lean on existing Convex reactivity: the reader/composer snapshots the thread's
 * newest outbound reply when it opens, and the `mailbox.latestReplyState` query
 * stays live. If a teammate's reply lands while the composer is open, the live
 * state's `messageId` changes — and we warn before sending a duplicate.
 *
 * Pure so the decision is unit-testable without mounting the composer.
 */

export interface ReplyStateSnapshot {
	/** The thread's newest outbound reply message id, or null if none yet. */
	messageId: string | null;
	/** Whether the current user is the one who sent that latest reply. */
	byIsYou: boolean;
}

/**
 * Decide whether the reply about to be sent is stale — i.e. a DIFFERENT
 * teammate replied to this thread after the composer was opened.
 *
 * - `opened` is the snapshot captured when the composer opened.
 * - `live` is the current value of the reactive latestReplyState query.
 *
 * Returns true only when the latest outbound reply changed AND it was not sent
 * by the current user (their own just-sent reply, or an undo/resend, must never
 * warn). A null `live` (personal mailbox, or no outbound reply) is never stale.
 */
export function isReplyStale(
	opened: ReplyStateSnapshot | null,
	live: ReplyStateSnapshot | null
): boolean {
	if (!live || live.messageId === null) return false;
	if (live.byIsYou) return false;
	const openedId = opened?.messageId ?? null;
	return live.messageId !== openedId;
}
