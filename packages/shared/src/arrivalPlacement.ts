/**
 * Read on arrival (SPEC §2.8): where a thread reads in the Priority view.
 * Derived, never stored from an action: the API recomputes it from current
 * state inside every mutation that changes one of its inputs
 * (`mail/arrival/projection.ts refreshArrivalProjection`). Pure.
 *
 * Precedence, first match wins:
 *   1. the thread's placement override (a message-scope Fix), unless it is
 *      older than an exact-wording candidate (below)
 *   2. a SETTLED needs-reply verdict → needs_me (a heuristic candidate still
 *      pending is not settled, so it reads as `today` until the verdict lands),
 *      unless the record carries a cold-pitch verdict: both are inferred, and
 *      the cold-pitch one only exists for a sender the owner never wrote to
 *   3. sender status unsubscribed / auto_archive → archived; digest → digest
 *   4. the sender's placement override
 *   5. a rule placement action, from the arrival record
 *   6. a cold-pitch verdict on the record → digest (#1381)
 *   7. the category: newsletter / promotion → digest, notification / receipt
 *      → updates, anything else → today
 *
 * An exact-wording candidate (changed bank details, a legal notice, an invoice
 * with payment details: `exactWordingDetector.ts`) is never buried (#1384):
 * when steps 3–7 place it in the digest or updates (the sender's digest
 * status, a sender override, a rule, a cold-pitch verdict, the category), it
 * reads as `today` instead. A thread override to the digest or updates that was set before
 * the candidate arrived is an older choice about the conversation, not about
 * this message, and does not bury it either ({@link doesThreadOverrideHold}).
 * The person's explicit choices still win: a thread override set after the
 * candidate arrived (or one to `needs_me`, `today` or `archived`), an
 * unsubscribed or auto-archived sender.
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
	const override = thread.placementOverride;
	if (override && doesThreadOverrideHold(record, override)) {
		return { placement: override.placement, decidedBy: 'thread_override' };
	}
	// An older override overruled by the wording: Today is the wording's doing.
	const isOverruled = override !== undefined;
	if (thread.isReplyNeeded && !record.isColdPitch) {
		return { placement: 'needs_me', decidedBy: 'needs_reply' };
	}
	const status = senderProfile?.status ?? 'keep';
	if (status === 'unsubscribed' || status === 'auto_archive') {
		return { placement: 'archived', decidedBy: 'sender_status' };
	}
	const placed = placementBelowStatus(record, status, senderProfile);
	if (
		record.isExactWordingCandidate &&
		(isBuried(placed.placement) || (isOverruled && placed.placement === 'today'))
	) {
		return { placement: 'today', decidedBy: 'exact_wording' };
	}
	return placed;
}

/** A placement an exact-wording candidate is lifted out of. */
function isBuried(placement: Placement): boolean {
	return placement === 'digest' || placement === 'updates';
}

/**
 * Whether the thread's override still places this message (#1384): always,
 * except a digest or updates override set before an exact-wording candidate
 * arrived. The depth decision drops the same override (`arrivalInputs`).
 * Unknown times read as an override set after the message. Pure.
 */
export function doesThreadOverrideHold(
	record: Pick<PlacementRecordInput, 'isExactWordingCandidate' | 'arrivedAt'>,
	override: NonNullable<PlacementThreadInput['placementOverride']>
): boolean {
	if (!record.isExactWordingCandidate || !isBuried(override.placement)) return true;
	if (override.setAt === undefined || record.arrivedAt === undefined) return true;
	return override.setAt >= record.arrivedAt;
}

/** Steps 3 (digest) to 7 of the precedence. Pure. */
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
	if (record.isColdPitch) return { placement: 'digest', decidedBy: 'cold_pitch' };
	return placementOfCategory(record.category);
}
