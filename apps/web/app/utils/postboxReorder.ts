/**
 * Manual ordering, shared by every Postbox list that has one.
 *
 * Both the nested label rail and the filter list are drag-to-reorder with a
 * keyboard-reachable equivalent, and both write a whole run of ids rather than
 * a delta. The step function is the same in both, so it lives here rather than
 * being written twice with two chances to get the edges wrong.
 */

/**
 * Move a sibling one slot up or down, returning the ids in their new order.
 *
 * This is the keyboard-reachable half of drag-to-reorder: the same write, one
 * step at a time. Returns the input unchanged when the move would fall off
 * either end, so a caller can skip the round trip.
 */
export function moveSibling(ids: readonly string[], id: string, delta: -1 | 1): string[] {
	const from = ids.indexOf(id);
	const to = from + delta;
	if (from === -1 || to < 0 || to >= ids.length) return [...ids];
	const next = [...ids];
	next.splice(from, 1);
	next.splice(to, 0, id);
	return next;
}
