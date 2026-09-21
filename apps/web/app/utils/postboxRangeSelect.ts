/**
 * Anchor-based range selection for the Postbox thread list.
 *
 * Selecting twenty messages used to mean twenty clicks: the list had a
 * per-row toggle and nothing else. These are the two pieces that turn it into
 * the file-manager idiom every mail client has — a selection ANCHOR that
 * Shift+click and Shift+J/K extend from, and the tri-state the header checkbox
 * renders (nothing / some / all of the loaded rows).
 *
 * Pure index math over the id order the list renders, so it is unit-testable
 * without mounting the Convex-backed list.
 */

/** What the header checkbox shows for the rows currently loaded. */
export type PostboxHeaderSelectionState = 'none' | 'partial' | 'all';

/**
 * Tri-state of the header checkbox over the rows on screen. An empty list is
 * 'none' (an empty folder must not render a checked "select all").
 */
export function headerSelectionState(
	pageIds: readonly string[],
	selected: ReadonlySet<string>
): PostboxHeaderSelectionState {
	if (pageIds.length === 0 || selected.size === 0) return 'none';
	let hit = 0;
	for (const id of pageIds) {
		if (selected.has(id)) hit += 1;
	}
	if (hit === 0) return 'none';
	return hit === pageIds.length ? 'all' : 'partial';
}

/**
 * The ids from `anchorId` to `targetId` inclusive, in list order and whichever
 * way round the two are. Returns just the target when the anchor is no longer
 * on the page (it was archived, or the folder re-paged under the selection) —
 * an anchor that has gone must degrade to a plain click, never to a range
 * spanning the whole list.
 */
export function rangeBetween(
	ids: readonly string[],
	anchorId: string | null,
	targetId: string
): string[] {
	const targetIndex = ids.indexOf(targetId);
	if (targetIndex < 0) return [];
	const anchorIndex = anchorId == null ? -1 : ids.indexOf(anchorId);
	if (anchorIndex < 0) return [targetId];
	const from = Math.min(anchorIndex, targetIndex);
	const to = Math.max(anchorIndex, targetIndex);
	return ids.slice(from, to + 1);
}
