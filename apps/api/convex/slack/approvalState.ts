/**
 * Slack approvals reference app — pure approval-state logic (Tier-2 connected
 * app, PP-26). Deterministic, `ctx`-free functions the Convex mutations, the
 * signed callback endpoint, and the restrict-only hold gate all share so the
 * quorum / expiration / duplicate-vote rules have exactly one definition.
 *
 * SAFETY MODEL — this app is RESTRICT-ONLY. A configured Slack approvals app can
 * only ever ADD a hold to an autonomous send; the single value it can ever
 * produce that RELEASES its own hold is {@link deriveApprovalStatus} === 'approved',
 * and even then the release only returns to the baseline the send would have
 * taken WITHOUT this app (every core autonomy gate still runs first). Nothing
 * here can approve a message, unblock a core gate, or send. Every non-'approved'
 * status — 'pending', 'rejected', 'expired' — HOLDS.
 *
 * FAIL-CLOSED — the only status that releases is 'approved', and it requires a
 * quorum of DISTINCT Slack approvers whose votes all landed on or before the
 * expiry. A late approve (votedAt > expiresAt) never counts, a single reject
 * from any approver holds, and duplicate votes from one Slack user collapse to
 * their first vote so a replayed callback can never inflate the quorum.
 */

/** A vote cast by a Slack user on an approval request. */
export interface SlackApprovalVote {
	/** Slack user id (`Uxxxx`). The dedup key: one effective vote per user. */
	readonly slackUserId: string;
	readonly decision: 'approve' | 'reject';
	/** Epoch ms the vote was recorded by Owlat (never a Slack-supplied time). */
	readonly votedAt: number;
}

/** The stored shape the status derivation reads. */
export interface SlackApprovalSnapshot {
	/** Distinct approvers required to reach 'approved'. Always >= 1. */
	readonly quorum: number;
	/** Epoch ms after which approve votes no longer count. */
	readonly expiresAt: number;
	readonly votes: readonly SlackApprovalVote[];
}

export type SlackApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/**
 * Collapse duplicate votes to one effective vote per Slack user, FIRST vote
 * wins. First-wins (rather than last-wins) means a Slack user can never flip a
 * recorded reject into an approve, and a replayed callback for a user who
 * already voted is inert — both properties keep the app restrict-only.
 */
export function effectiveVotes(votes: readonly SlackApprovalVote[]): readonly SlackApprovalVote[] {
	const byUser = new Map<string, SlackApprovalVote>();
	for (const vote of votes) {
		if (!byUser.has(vote.slackUserId)) byUser.set(vote.slackUserId, vote);
	}
	return Object.freeze([...byUser.values()]);
}

/**
 * Decide whether recording `incoming` changes the recorded set. Returns the new
 * vote to append, or `null` when the Slack user already has an effective vote
 * (duplicate / replay / vote-flip attempt) — the caller records nothing and the
 * write is idempotent.
 */
export function voteToRecord(
	existing: readonly SlackApprovalVote[],
	incoming: SlackApprovalVote
): SlackApprovalVote | null {
	for (const vote of existing) {
		if (vote.slackUserId === incoming.slackUserId) return null;
	}
	return incoming;
}

/** Count DISTINCT Slack users who approved on or before expiry. */
export function countApprovers(snapshot: SlackApprovalSnapshot): number {
	let approvers = 0;
	for (const vote of effectiveVotes(snapshot.votes)) {
		if (vote.decision === 'approve' && vote.votedAt <= snapshot.expiresAt) approvers += 1;
	}
	return approvers;
}

/**
 * Derive the request status from its votes and the current time. Pure and
 * deterministic — the same snapshot and `now` always yield the same status.
 *
 * Precedence is safety-first:
 *   1. any effective reject  → 'rejected' (a single approver's reject holds);
 *   2. distinct approvers on-or-before expiry >= quorum → 'approved' (release);
 *   3. now >= expiresAt      → 'expired'  (quorum never reached in time);
 *   4. otherwise             → 'pending'.
 *
 * Only outcome (2) releases the hold. A malformed quorum (< 1) can never be
 * satisfied honestly, so it is clamped to Infinity — the request can never reach
 * 'approved' and therefore always holds.
 */
export function deriveApprovalStatus(
	snapshot: SlackApprovalSnapshot,
	now: number
): SlackApprovalStatus {
	const votes = effectiveVotes(snapshot.votes);
	for (const vote of votes) {
		if (vote.decision === 'reject') return 'rejected';
	}
	const quorum =
		Number.isSafeInteger(snapshot.quorum) && snapshot.quorum >= 1
			? snapshot.quorum
			: Number.POSITIVE_INFINITY;
	if (countApprovers(snapshot) >= quorum) return 'approved';
	if (now >= snapshot.expiresAt) return 'expired';
	return 'pending';
}

/** The one status that releases this app's restrict-only hold. */
export function isApproved(snapshot: SlackApprovalSnapshot, now: number): boolean {
	return deriveApprovalStatus(snapshot, now) === 'approved';
}
