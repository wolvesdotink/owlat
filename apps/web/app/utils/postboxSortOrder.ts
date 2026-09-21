/**
 * Postbox message-list sort order — which end of the folder the list starts at:
 *
 *   - 'newest' → arrival descending (the default, and the only order the list
 *                had before this control existed)
 *   - 'oldest' → arrival ascending, the standard way to clear a backlog front
 *                to back
 *
 * Date direction only: the server flips `.order()` on the existing arrival
 * index, so this adds no read cost and no new index. Sorting by size is a
 * separate, larger change (it needs an index that does not exist).
 *
 * A stored preference of the person, not of a folder: someone working oldest-
 * first works that way everywhere. Pure derivations so the mapping stays
 * unit-testable without mounting the Convex-backed layout.
 */

export type PostboxSortOrder = 'newest' | 'oldest';

export const POSTBOX_SORT_ORDER_DEFAULT: PostboxSortOrder = 'newest';

/** Normalise a stored/unknown value to a valid order, defaulting safely. */
export function resolvePostboxSortOrder(value: string | undefined | null): PostboxSortOrder {
	return value === 'oldest' ? value : POSTBOX_SORT_ORDER_DEFAULT;
}

/**
 * The picker options, as a radio group rather than a flip: the list header's
 * Display menu shows both orders at once. Module scope never calls `useI18n`,
 * so `label` is the catalog key the rendering surface resolves through `t()` —
 * the same shape the density and reading-pane registries use.
 */
export const POSTBOX_SORT_ORDER_OPTIONS: Array<{
	value: PostboxSortOrder;
	label: string;
}> = [
	{ value: 'newest', label: 'shared.postboxSortOrder.newest' },
	{ value: 'oldest', label: 'shared.postboxSortOrder.oldest' },
];

/**
 * What the read should send. The default order is expressed by sending NOTHING:
 * a client on the default keeps the exact query shape (and cursors) it had
 * before the control existed.
 */
export function postboxSortOrderArg(order: PostboxSortOrder): PostboxSortOrder | undefined {
	return order === POSTBOX_SORT_ORDER_DEFAULT ? undefined : order;
}
