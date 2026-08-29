/**
 * Team Inbox ordering rules: "needs-attention", and the waiting time behind
 * "oldest waiting".
 *
 * Pure comparators + predicates so the rules can be unit-tested in isolation
 * and reused by the list query to order the page it fetched — and so the list,
 * the filter counts and the row chip cannot disagree about what "waiting"
 * means.
 *
 * ── needs-attention ──
 * The rule (most-urgent first):
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

/**
 * ── waiting time ──
 *
 * A shared inbox exists to manage one number — how long a customer has waited
 * — and nothing anywhere showed it: the sorts were `needs-attention` or
 * `newest`, and `newest` buries the oldest neglected thread by construction.
 *
 * The derivation leans on a property of the thread module: `lastMessageAt` is
 * bumped ONLY by the `inbound_activity` reducer (inbox/threads/module.ts), so
 * it is not "the newest message" in general — it is "the newest message THEY
 * sent". Time since it is therefore, exactly, how long the customer has been
 * waiting, with no join to the message table.
 *
 * A thread is waiting on US when it is `open` and not currently snoozed:
 *   - `waiting` means the opposite — we replied and the ball is theirs;
 *   - `resolved` / `closed` are done;
 *   - a snoozed thread is a deliberate "not now", so counting its age as
 *     neglect would be a lie.
 */
export type WaitingThread = {
	status: 'open' | 'waiting' | 'resolved' | 'closed';
	lastMessageAt: number;
	snoozedUntil?: number;
};

/**
 * The escalation the "Waiting > 24h" pill counts at.
 *
 * MIRRORED in apps/web/app/utils/inboxWaiting.ts, which paints the row chip's
 * overdue tier — the two MUST stay in lockstep or the pill counts three and
 * only two rows look overdue. Both sides pin the value in their own test.
 */
export const WAITING_OVER_24H_MS = 24 * 60 * 60 * 1000;

/** Is this thread waiting on us at all? See the note above for the rule. */
export function isWaitingOnUs(thread: WaitingThread, now: number): boolean {
	if (thread.status !== 'open') return false;
	return thread.snoozedUntil === undefined || thread.snoozedUntil <= now;
}

/**
 * How long the customer has waited, in ms — `null` when the thread is not
 * waiting on us, so a caller cannot render an age for a resolved thread.
 * Clamped at zero: a clock skew must not render as a negative wait.
 */
export function waitingMs(thread: WaitingThread, now: number): number | null {
	if (!isWaitingOnUs(thread, now)) return null;
	return Math.max(0, now - thread.lastMessageAt);
}

/**
 * Has this thread been waiting past the escalation the pill counts?
 *
 * Inclusive at the boundary, which is what `buildThreadQuery`'s index range
 * (`lastMessageAt <= now - WAITING_OVER_24H_MS`) selects — the predicate and
 * the range have to agree or a row sits in the pill's count without matching
 * the rule that named it.
 */
export function isWaitingOver24h(thread: WaitingThread, now: number): boolean {
	const waited = waitingMs(thread, now);
	return waited !== null && waited >= WAITING_OVER_24H_MS;
}

/**
 * `Array#sort` comparator for the "oldest waiting" order: the customer who has
 * waited longest leads. Threads that are not waiting on us sort after every
 * one that is — they have no waiting time to compare, and burying a real wait
 * under a resolved thread is the failure this sort exists to prevent.
 */
export function compareOldestWaiting(a: WaitingThread, b: WaitingThread, now: number): number {
	const aWaited = waitingMs(a, now);
	const bWaited = waitingMs(b, now);
	if (aWaited === null && bWaited === null) return a.lastMessageAt - b.lastMessageAt;
	if (aWaited === null) return 1;
	if (bWaited === null) return -1;
	return bWaited - aWaited;
}
