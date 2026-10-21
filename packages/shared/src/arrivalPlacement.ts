/**
 * Read on arrival (SPEC §2.8): where a thread reads in the Priority view.
 * Derived, never stored from an action: the API recomputes it from current
 * state inside every mutation that changes one of its inputs
 * (`mail/arrival/projection.ts refreshArrivalProjection`). Pure.
 *
 * Precedence, first match wins:
 *   1. the thread's placement override (a message-scope Fix)
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
 */

import type {
	ComputePlacementResult,
	MailCategory,
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
	if (thread.isReplyNeeded && !record.isColdPitch) {
		return { placement: 'needs_me', decidedBy: 'needs_reply' };
	}
	const status = senderProfile?.status ?? 'keep';
	if (status === 'unsubscribed' || status === 'auto_archive') {
		return { placement: 'archived', decidedBy: 'sender_status' };
	}
	if (status === 'digest') return { placement: 'digest', decidedBy: 'sender_status' };
	if (senderProfile?.placementOverride) {
		return { placement: senderProfile.placementOverride, decidedBy: 'sender_override' };
	}
	if (record.rulePlacement) return { placement: record.rulePlacement, decidedBy: 'rule' };
	if (record.isColdPitch) return { placement: 'digest', decidedBy: 'cold_pitch' };
	return placementOfCategory(record.category);
}
