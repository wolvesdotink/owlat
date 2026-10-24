/**
 * Geometry for a variable-height virtual list, kept free of the DOM so the
 * index math and the anchor arithmetic are testable on their own.
 *
 * Coordinates are "list coordinates": 0 is the top of the first row, and a
 * row's top is the sum of the heights of every row before it.
 */

export interface VirtualListLayout {
	/** Row keys in render order. */
	keys: readonly string[];
	/** Key to row index. */
	indexOf: ReadonlyMap<string, number>;
	/**
	 * `starts[i]` is the top of row `i`; `starts[keys.length]` is the height of
	 * the whole list. Prefix sums, so finding the row at a scroll position is a
	 * binary search instead of a walk over every row.
	 */
	starts: Float64Array;
}

/** A row the reader can see, and how far below the viewport's top its top sits. */
export interface VirtualListAnchor {
	key: string;
	offset: number;
}

/** Visible rows are at most this many; past it, the first ones decide anyway. */
const MAX_ANCHORS = 64;

export function buildVirtualListLayout(
	keys: readonly string[],
	sizeAt: (index: number) => number
): VirtualListLayout {
	const starts = new Float64Array(keys.length + 1);
	const indexOf = new Map<string, number>();
	for (let i = 0; i < keys.length; i++) {
		indexOf.set(keys[i]!, i);
		starts[i + 1] = starts[i]! + Math.max(0, sizeAt(i));
	}
	return { keys, indexOf, starts };
}

export function virtualListHeight(layout: VirtualListLayout): number {
	return layout.starts[layout.keys.length]!;
}

export function virtualRowSize(layout: VirtualListLayout, index: number): number {
	return layout.starts[index + 1]! - layout.starts[index]!;
}

/**
 * The row covering list position `y`, clamped to the first and last row.
 * Returns -1 for an empty list.
 */
export function virtualRowAt(layout: VirtualListLayout, y: number): number {
	const count = layout.keys.length;
	if (count === 0) return -1;
	let low = 0;
	let high = count - 1;
	// The last row whose top is at or above `y`.
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (layout.starts[mid]! <= y) low = mid;
		else high = mid - 1;
	}
	return low;
}

/**
 * The half-open index range `[start, end)` of rows that intersect
 * `[top - overscan, top + viewport + overscan]`.
 */
export function virtualRowRange(
	layout: VirtualListLayout,
	top: number,
	viewport: number,
	overscan: number
): { start: number; end: number } {
	if (layout.keys.length === 0) return { start: 0, end: 0 };
	const start = virtualRowAt(layout, top - overscan);
	const end = virtualRowAt(layout, top + Math.max(0, viewport) + overscan) + 1;
	return { start, end };
}

/**
 * The rows visible in `[top, top + viewport)`, first one first, each with its
 * offset from `top`. Several rather than one, so the position survives the
 * first visible row being deleted.
 */
export function captureVirtualListAnchors(
	layout: VirtualListLayout,
	top: number,
	viewport: number
): VirtualListAnchor[] {
	const anchors: VirtualListAnchor[] = [];
	const first = virtualRowAt(layout, top);
	if (first < 0) return anchors;
	const bottom = top + Math.max(0, viewport);
	for (let i = first; i < layout.keys.length && anchors.length < MAX_ANCHORS; i++) {
		const start = layout.starts[i]!;
		if (i > first && start >= bottom) break;
		anchors.push({ key: layout.keys[i]!, offset: start - top });
	}
	return anchors;
}

/**
 * The list position to scroll to so the first anchor still present in
 * `layout` sits where it sat before, or `null` when none of them survived.
 */
export function restoreVirtualListAnchor(
	layout: VirtualListLayout,
	anchors: readonly VirtualListAnchor[]
): number | null {
	for (const anchor of anchors) {
		const index = layout.indexOf.get(anchor.key);
		if (index !== undefined) return layout.starts[index]! - anchor.offset;
	}
	return null;
}
