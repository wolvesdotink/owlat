/**
 * The approval state machine that decides whether a held draft may proceed.
 *
 * This is the security core of the reference app, and it is deliberately PURE
 * and deterministic: no clocks, no network, no mutation. Time is always an
 * explicit argument, so every quorum / expiry / duplicate-vote outcome is
 * reproducible in a unit test. The one rule the whole gate rests on is encoded
 * here: the ONLY state that clears the hold is `approved` (a real human quorum
 * reached inside the window). Everything else — pending, expired, rejected, or
 * an unknown request — keeps holding. There is no state, and no vote, that can
 * make this model emit an "auto-send" instruction; the strongest thing it can
 * say is "we no longer object", which the gate layer turns into a restrict-only
 * `no-objection` that still leaves Owlat's core gates in force.
 */

export type Vote = 'approve' | 'reject';

/** One voter's current position. At most one per voter (see {@link recordVote}). */
export interface ApprovalVote {
	readonly voterId: string;
	readonly vote: Vote;
	readonly castAtMs: number;
}

/** An immutable snapshot of one pending approval. */
export interface ApprovalRequest {
	/** Stable identity of the held draft (e.g. the outbound message id). */
	readonly id: string;
	readonly organizationId: string;
	/** How many distinct `approve` votes clear the hold (quorum). ≥ 1. */
	readonly requiredApprovals: number;
	readonly createdAtMs: number;
	/** Votes cast at/after this instant are refused; an un-approved request expires. */
	readonly expiresAtMs: number;
	readonly votes: readonly ApprovalVote[];
}

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired';

export interface CreateApprovalInput {
	readonly id: string;
	readonly organizationId: string;
	readonly requiredApprovals: number;
	readonly createdAtMs: number;
	readonly ttlMs: number;
}

/** Why a vote was not counted, so the callback layer can report it honestly. */
export type VoteRejectionReason = 'window_closed' | 'unknown_voter';

export type RecordVoteResult =
	| { readonly accepted: true; readonly request: ApprovalRequest }
	| {
			readonly accepted: false;
			readonly reason: VoteRejectionReason;
			readonly request: ApprovalRequest;
	  };

function isPositiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

/**
 * Build a fresh approval request. Throws on a non-positive quorum or TTL — a
 * misconfigured gate must fail loudly at construction, never silently degrade to
 * "0 approvals needed" (which would be an approval bypass).
 */
export function createApprovalRequest(input: CreateApprovalInput): ApprovalRequest {
	if (!isPositiveInteger(input.requiredApprovals)) {
		throw new RangeError('requiredApprovals must be a positive integer');
	}
	if (!isPositiveInteger(input.ttlMs)) {
		throw new RangeError('ttlMs must be a positive integer');
	}
	if (!Number.isSafeInteger(input.createdAtMs)) {
		throw new RangeError('createdAtMs must be a safe integer');
	}
	return Object.freeze({
		id: input.id,
		organizationId: input.organizationId,
		requiredApprovals: input.requiredApprovals,
		createdAtMs: input.createdAtMs,
		expiresAtMs: input.createdAtMs + input.ttlMs,
		votes: Object.freeze([]),
	});
}

/**
 * Apply one voter's vote, enforcing the two anti-inflation rules:
 *   - one position per voter — a repeat click (identical or changed) REPLACES the
 *     voter's prior vote, so a voter can never be counted twice toward quorum;
 *   - the vote must land strictly inside the window — a vote cast at/after
 *     `expiresAtMs` is refused, so a late click cannot revive an expired hold.
 * The voter id must be non-empty (an unauthenticated / unattributable click is
 * dropped). Returns the (possibly unchanged) request plus whether it counted.
 */
export function recordVote(request: ApprovalRequest, vote: ApprovalVote): RecordVoteResult {
	if (vote.voterId.trim().length === 0) {
		return { accepted: false, reason: 'unknown_voter', request };
	}
	if (vote.castAtMs >= request.expiresAtMs) {
		return { accepted: false, reason: 'window_closed', request };
	}
	const normalized: ApprovalVote = Object.freeze({
		voterId: vote.voterId,
		vote: vote.vote,
		castAtMs: vote.castAtMs,
	});
	const others = request.votes.filter((existing) => existing.voterId !== vote.voterId);
	const next: ApprovalRequest = Object.freeze({
		...request,
		votes: Object.freeze([...others, normalized]),
	});
	return { accepted: true, request: next };
}

/** Distinct `approve` votes currently standing. */
export function approvalCount(request: ApprovalRequest): number {
	return request.votes.filter((vote) => vote.vote === 'approve').length;
}

/** True iff any voter has registered a `reject` (a human objection to holding). */
export function hasRejection(request: ApprovalRequest): boolean {
	return request.votes.some((vote) => vote.vote === 'reject');
}

/**
 * Resolve the request against `nowMs`. Precedence is chosen for safety, not
 * convenience: a `reject` always wins (a human said no), quorum clears the hold
 * only when no rejection stands, and an un-approved request lapses to `expired`
 * once the window closes. `approved` and `rejected` are terminal; only `pending`
 * can still change. NOTHING here returns a value that authorizes sending.
 */
export function evaluateApproval(request: ApprovalRequest, nowMs: number): ApprovalState {
	if (hasRejection(request)) return 'rejected';
	if (approvalCount(request) >= request.requiredApprovals) return 'approved';
	if (nowMs >= request.expiresAtMs) return 'expired';
	return 'pending';
}
