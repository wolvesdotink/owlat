/**
 * Undoing what a purged source set on an item (for the erasure purge paths):
 * every item records which source set its current status and disposition
 * (`statusSource` / `dispositionSource`: an interpretation `sourceKey`,
 * `user:<id>` for a reaction, `op:<ref>` for a recorded operation). When a
 * message is purged, what IT set goes back to the neutral state and the item
 * is flagged for review; what a person or another source set stays. Pure.
 */

import type { Doc } from '../../_generated/dataModel';

export type TransitionFields = Pick<
	Doc<'threadItems'>,
	'status' | 'disposition' | 'completion' | 'statusSource' | 'dispositionSource'
>;

/**
 * The item patch that resets whatever `purgedSourceKey` set, as a message or
 * as a recorded operation on it (`op:<sourceKey>`): its status back
 * to `open` (no completion), its disposition back to `unanswered`, with
 * `isReviewNeeded`. Returns null when the source set neither. The order
 * stamp (`lastTransitionAt`) falls back to what still stands.
 */
export function resetTransitionsFrom(
	item: TransitionFields,
	purgedSourceKey: string
): Partial<Doc<'threadItems'>> | null {
	// The source itself (a message read), or a recorded operation on it (a
	// bounced send: `sendFailure.ts` writes `op:<sourceKey>`).
	const isFrom = (setBy: string | undefined) =>
		setBy === purgedSourceKey || setBy === `op:${purgedSourceKey}`;
	const isStatus = isFrom(item.statusSource?.sourceKey);
	const isDisposition = isFrom(item.dispositionSource?.sourceKey);
	if (!isStatus && !isDisposition) return null;
	const remaining = [
		isStatus ? undefined : item.statusSource?.at,
		isDisposition ? undefined : item.dispositionSource?.at,
	].filter((at): at is number => at !== undefined);
	return {
		...(isStatus
			? { status: 'open' as const, completion: undefined, statusSource: undefined }
			: {}),
		...(isDisposition ? { disposition: 'unanswered' as const, dispositionSource: undefined } : {}),
		lastTransitionAt: remaining.length > 0 ? Math.max(...remaining) : undefined,
		isReviewNeeded: true,
	};
}
