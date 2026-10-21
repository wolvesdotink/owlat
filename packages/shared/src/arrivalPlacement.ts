/**
 * Read on arrival (SPEC §2.8): where a thread reads in the Priority view.
 * Derived, never stored from an action: the API recomputes it from current
 * state inside every mutation that changes one of its inputs
 * (`mail/arrival/projection.ts refreshArrivalProjection`). Pure.
 *
 * Precedence, first match wins:
 *   1. the thread's placement override (a message-scope Fix)
 *   2. a SETTLED needs-reply verdict → needs_me (a heuristic candidate still
 *      pending is not settled, so it reads as `today` until the verdict lands)
 *   3. sender status unsubscribed / auto_archive → archived; digest → digest
 *   4. the sender's placement override
 *   5. a rule placement action, from the arrival record
 *   6. the category: newsletter / promotion → digest, notification / receipt
 *      → updates, anything else → today
 *
 * An exact-wording candidate (changed bank details, a legal notice, an invoice
 * with payment details: `exactWordingDetector.ts`) is never buried (#1384):
 * when steps 3–6 place it in the digest or updates (the sender's digest
 * status, a sender override, a rule, the category), it reads as `today`
 * instead. The person's explicit choices still win: the thread's own
 * override, an unsubscribed or auto-archived sender.
 */

import type {
	ComputePlacementResult,
	MailCategory,
	Placement,
	PlacementRecordInput,
	PlacementSenderInput,
	PlacementThreadInput,
} from './arrival';

function placementOfCategory(category: MailCategory | undefined): ComputePlacementResult {
	switch (category) {
		case 'newsletter':
		case 'promotion':
			return { placement: 'digest', decidedBy: 'category' };
		case 'notification':
		case 'receipt':
			return { placement: 'updates', decidedBy: 'category' };
		default:
			return { placement: 'today', decidedBy: 'category' };
	}
}

/** The precedence of the module doc. A null sender profile reads as `keep`. Pure. */
export function computePlacement(
	record: PlacementRecordInput,
	thread: PlacementThreadInput,
	senderProfile: PlacementSenderInput | null
): ComputePlacementResult {
	if (thread.placementOverride) {
		return { placement: thread.placementOverride.placement, decidedBy: 'thread_override' };
	}
	if (thread.isReplyNeeded) return { placement: 'needs_me', decidedBy: 'needs_reply' };
	const status = senderProfile?.status ?? 'keep';
	if (status === 'unsubscribed' || status === 'auto_archive') {
		return { placement: 'archived', decidedBy: 'sender_status' };
	}
	const placed = placementBelowStatus(record, status, senderProfile);
	if (record.isExactWordingCandidate && isBuried(placed.placement)) {
		return { placement: 'today', decidedBy: 'exact_wording' };
	}
	return placed;
}

/** A placement an exact-wording candidate is lifted out of. */
function isBuried(placement: Placement): boolean {
	return placement === 'digest' || placement === 'updates';
}

/** Steps 3 (digest) to 6 of the precedence. Pure. */
function placementBelowStatus(
	record: PlacementRecordInput,
	status: PlacementSenderInput['status'],
	senderProfile: PlacementSenderInput | null
): ComputePlacementResult {
	if (status === 'digest') return { placement: 'digest', decidedBy: 'sender_status' };
	if (senderProfile?.placementOverride) {
		return { placement: senderProfile.placementOverride, decidedBy: 'sender_override' };
	}
	if (record.rulePlacement) return { placement: record.rulePlacement, decidedBy: 'rule' };
	return placementOfCategory(record.category);
}
