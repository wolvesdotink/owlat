/**
 * Team Inbox "needs-attention" ordering.
 *
 * A pure comparator so it can be unit-tested in isolation and reused by the
 * list query to order the page it fetched. The rule (most-urgent first):
 *
 *   1. Drafts ready  — a reply is drafted and waiting for a human ok.
 *   2. Unassigned & unread — nobody owns it and nobody has read the new activity.
 *   3. Everything else, oldest activity first ("oldest open").
 *
 * Within every tier the tiebreak is oldest `lastMessageAt` first, so the
 * longest-waiting conversation always floats up.
 */

export type NeedsAttentionThread = {
	latestDraftStatus?: 'pending' | 'approved' | 'rejected' | 'sent';
	assignedTo?: string;
	unread: boolean;
	lastMessageAt: number;
};

/** Lower rank = more urgent. */
function attentionRank(thread: NeedsAttentionThread): number {
	if (thread.latestDraftStatus === 'pending') return 0;
	if (!thread.assignedTo && thread.unread) return 1;
	return 2;
}

/** `Array#sort` comparator: negative when `a` should come before `b`. */
export function compareNeedsAttention(a: NeedsAttentionThread, b: NeedsAttentionThread): number {
	const rankDelta = attentionRank(a) - attentionRank(b);
	if (rankDelta !== 0) return rankDelta;
	// Same tier: oldest activity first.
	return a.lastMessageAt - b.lastMessageAt;
}
