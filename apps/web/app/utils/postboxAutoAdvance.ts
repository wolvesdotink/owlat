/**
 * Auto-advance after triaging the open message (archive / trash / snooze /
 * spam) in the Postbox reader.
 *
 * Pure list arithmetic only — the caller supplies the ids in the list's
 * current VISUAL order (the optimistic-hide-filtered order rendered by
 * PostboxThreadList) and navigates to the returned id, or back to the list
 * when `null` comes back (mode 'back-to-list', unknown current id, or the
 * adjacent slot falls off either end of the list).
 */

export type PostboxAutoAdvanceMode = 'next' | 'previous' | 'back-to-list';

export const POSTBOX_AUTO_ADVANCE_DEFAULT: PostboxAutoAdvanceMode = 'next';

export const POSTBOX_AUTO_ADVANCE_OPTIONS: Array<{
	value: PostboxAutoAdvanceMode;
	label: string;
}> = [
	{ value: 'next', label: 'Open the next conversation' },
	{ value: 'previous', label: 'Open the previous conversation' },
	{ value: 'back-to-list', label: 'Go back to the list' },
];

/**
 * Pick the conversation to open after `currentId` is triaged away.
 *
 * Returns the adjacent id in `orderedIds` per `mode`, or `null` to mean
 * "fall back to the list" (mode 'back-to-list', current id not in the
 * list, or no adjacent item on that side).
 */
export function pickAdjacentMessageId(
	orderedIds: readonly string[],
	currentId: string,
	mode: PostboxAutoAdvanceMode
): string | null {
	if (mode === 'back-to-list') return null;
	const index = orderedIds.indexOf(currentId);
	if (index === -1) return null;
	const adjacent = mode === 'next' ? orderedIds[index + 1] : orderedIds[index - 1];
	return adjacent ?? null;
}
