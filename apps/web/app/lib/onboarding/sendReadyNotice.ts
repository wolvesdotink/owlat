/**
 * Pure rules for the "you can send now" unblock notice.
 *
 * The backend (`auth/sendReadyNotices.ts`) writes one notice per member whose
 * onboarding first-send step was still open when the instance finally got an
 * outbound transport. The member's session feeds each query update through
 * {@link planSendReadyToast}, which picks the single notice worth surfacing —
 * a burst of rows (a transport that flapped) is still one toast, and a notice
 * already surfaced this session is never re-toasted while the acknowledge
 * mutation is in flight.
 *
 * Kept free of Vue / Convex so the copy and the de-dup are unit-testable in
 * isolation (mirrors lib/inbox/assignmentNoticeRules.ts).
 */

/** The onboarding step this notice unblocks. */
export const SEND_READY_STEP_ID = 'firstSendDone' as const;

/**
 * Where the notice's action lands: the dashboard's Getting started card, with
 * the first-send step named so the card can scroll to and highlight it.
 */
export const SEND_READY_DEEP_LINK = `/dashboard?step=${SEND_READY_STEP_ID}`;

/** One pending notice as `auth.sendReadyNotices.getState` returns it. */
export interface SendReadyNotice {
	id: string;
	createdAt: number;
}

/**
 * The notice to surface now, or `null` when there is nothing new. Newest wins:
 * the message is about a state ("sending works now"), not about each row, so
 * older pending rows are covered by surfacing the latest one.
 *
 * @param notices  pending notices from the current query update
 * @param surfaced ids already toasted this session (not mutated)
 */
export function planSendReadyToast(
	notices: readonly SendReadyNotice[] | undefined,
	surfaced: ReadonlySet<string>
): SendReadyNotice | null {
	if (!notices || notices.length === 0) return null;
	const fresh = notices.filter((notice) => !surfaced.has(notice.id));
	if (fresh.length === 0) return null;
	return fresh.reduce((newest, notice) => (notice.createdAt > newest.createdAt ? notice : newest));
}

/** In-app toast copy — states the new capability, then the one thing left to do. */
export function sendReadyToastMessage(): string {
	return 'You can send now — finish your test send';
}
