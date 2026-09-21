/**
 * Fixed-height windowed rendering for the Postbox thread list.
 *
 * Large folders (10k+ messages) can't render a `<li>` per row without tanking
 * scroll performance, even with `content-visibility: auto`. This composable
 * maps the scroll container's `scrollTop`/height to the slice of row indices
 * that are actually near the viewport (± an overscan margin) so the list only
 * mounts a bounded number of rows. Row height is a KNOWN per-density constant
 * (postboxDensity.POSTBOX_ROW_HEIGHT), so no dynamic measurement is needed.
 *
 * The pure range/reveal helpers are exported separately so the index math is
 * unit-testable without a DOM.
 */
import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

export interface VirtualRange {
	/** First row index to render (inclusive). */
	startIndex: number;
	/** One past the last row index to render (exclusive). */
	endIndex: number;
	/** Pixel offset of the first rendered row from the top of the list. */
	offsetY: number;
	/** Total scroll height of the full (un-windowed) list. */
	totalHeight: number;
}

/**
 * Map a scroll position to the row window to render. Overscan is clamped at
 * both ends so the first/last pages never render negative or out-of-range
 * indices.
 */
export function computeVirtualRange(o: {
	scrollTop: number;
	viewportHeight: number;
	rowHeight: number;
	itemCount: number;
	overscan: number;
}): VirtualRange {
	const rowHeight = o.rowHeight;
	const itemCount = Math.max(0, o.itemCount);
	const totalHeight = itemCount * rowHeight;
	if (itemCount === 0 || rowHeight <= 0) {
		return { startIndex: 0, endIndex: 0, offsetY: 0, totalHeight };
	}
	const scrollTop = Math.min(Math.max(0, o.scrollTop), totalHeight);
	const viewportHeight = Math.max(0, o.viewportHeight);
	const overscan = Math.max(0, o.overscan);

	const first = Math.floor(scrollTop / rowHeight);
	const visibleCount = Math.ceil(viewportHeight / rowHeight);
	const startIndex = Math.max(0, first - overscan);
	// +1 so a partially-visible bottom row is always included before overscan.
	const endIndex = Math.min(itemCount, first + visibleCount + overscan + 1);
	return { startIndex, endIndex, offsetY: startIndex * rowHeight, totalHeight };
}

/**
 * "Nearest" scroll semantics for a row that occupies [rowTop, rowTop+height):
 * scroll up if it's above the viewport, down if it's below, otherwise leave
 * the position untouched.
 */
function revealTop(rowTop: number, rowHeight: number, scrollTop: number, viewportHeight: number) {
	const rowBottom = rowTop + rowHeight;
	if (rowTop < scrollTop) return rowTop;
	if (rowBottom > scrollTop + viewportHeight) return rowBottom - viewportHeight;
	return scrollTop;
}

/**
 * Given a target row index, return the `scrollTop` that brings it fully into
 * view with "nearest" semantics. Used to keep the keyboard-focused row visible
 * even when it isn't currently mounted.
 */
export function scrollTopToRevealIndex(o: {
	index: number;
	rowHeight: number;
	scrollTop: number;
	viewportHeight: number;
}): number {
	return revealTop(o.index * o.rowHeight, o.rowHeight, o.scrollTop, o.viewportHeight);
}

// --- Section-aware windowing -------------------------------------------------
// The grouped renderers (conversation view, smart-inbox categories) interleave
// fixed-height section HEADERS with fixed-height rows, so a flat
// `index * rowHeight` no longer locates a row. These helpers thread the header
// offsets through the same math.
//
// The window is expressed as per-section spacers rather than one absolute
// translate: the category list's headers are `position: sticky`, which only
// works in normal flow. A spacer above and below the rendered slice keeps the
// scroll height honest without taking anything out of flow.

/** The slice of one section to mount, plus the spacers standing in for the rest. */
export interface SectionWindow {
	/** First row index WITHIN the section to render (inclusive). */
	startIndex: number;
	/** One past the last row index within the section (exclusive). */
	endIndex: number;
	/** Pixel spacer standing in for the section's skipped leading rows. */
	padTop: number;
	/** Pixel spacer standing in for the section's skipped trailing rows. */
	padBottom: number;
}

/**
 * Map a scroll position to one render window PER SECTION. Sections are given
 * as their row counts in render order (a collapsed section is simply 0, and
 * still costs its header). Overscan is expressed in rows and clamped inside
 * each section, so no window ever names a row the section doesn't have.
 */
export function computeSectionedVirtualRanges(o: {
	scrollTop: number;
	viewportHeight: number;
	rowHeight: number;
	headerHeight: number;
	sectionCounts: readonly number[];
	overscan: number;
}): { totalHeight: number; sections: SectionWindow[] } {
	const rowHeight = Math.max(0, o.rowHeight);
	const headerHeight = Math.max(0, o.headerHeight);
	const counts = o.sectionCounts.map((c) => Math.max(0, c));
	const totalHeight = counts.reduce((sum, c) => sum + headerHeight + c * rowHeight, 0);
	if (rowHeight <= 0) {
		return {
			totalHeight,
			sections: counts.map(() => ({ startIndex: 0, endIndex: 0, padTop: 0, padBottom: 0 })),
		};
	}
	const scrollTop = Math.max(0, o.scrollTop);
	const overscanPx = Math.max(0, o.overscan) * rowHeight;
	const windowTop = scrollTop - overscanPx;
	const windowBottom = scrollTop + Math.max(0, o.viewportHeight) + overscanPx;

	let top = 0;
	const sections: SectionWindow[] = [];
	for (const count of counts) {
		top += headerHeight;
		const rowsTop = top;
		const clamp = (n: number) => Math.min(Math.max(n, 0), count);
		const startIndex = clamp(Math.floor((windowTop - rowsTop) / rowHeight));
		const endIndex = Math.max(startIndex, clamp(Math.ceil((windowBottom - rowsTop) / rowHeight)));
		sections.push({
			startIndex,
			endIndex,
			padTop: startIndex * rowHeight,
			padBottom: (count - endIndex) * rowHeight,
		});
		top += count * rowHeight;
	}
	return { totalHeight, sections };
}

/**
 * Pixel top of the row at `flatIndex` — the index into the sections' rows
 * concatenated in render order, which is exactly how the grouped lists' j/k
 * navigation numbers them. Returns null when the index is out of range.
 */
export function sectionedRowTop(o: {
	flatIndex: number;
	rowHeight: number;
	headerHeight: number;
	sectionCounts: readonly number[];
}): number | null {
	if (o.flatIndex < 0) return null;
	let top = 0;
	let remaining = o.flatIndex;
	for (const raw of o.sectionCounts) {
		const count = Math.max(0, raw);
		top += Math.max(0, o.headerHeight);
		if (remaining < count) return top + remaining * o.rowHeight;
		remaining -= count;
		top += count * o.rowHeight;
	}
	return null;
}

/**
 * The `scrollTop` that reveals a section list's `flatIndex`-th row with the
 * same "nearest" semantics as the flat list. Returns the current `scrollTop`
 * unchanged when the index is out of range.
 */
export function scrollTopToRevealSectionedIndex(o: {
	flatIndex: number;
	rowHeight: number;
	headerHeight: number;
	sectionCounts: readonly number[];
	scrollTop: number;
	viewportHeight: number;
}): number {
	const rowTop = sectionedRowTop(o);
	if (rowTop == null) return o.scrollTop;
	return revealTop(rowTop, o.rowHeight, o.scrollTop, o.viewportHeight);
}

/**
 * True when the scroll position is within `marginPx` of the end of the
 * content — the trigger for growing the page before the user reaches the
 * bottom, so an infinite list never shows its seam.
 */
export function isNearListEnd(o: {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	marginPx: number;
}): boolean {
	return o.scrollHeight - o.scrollTop - o.clientHeight < o.marginPx;
}

/**
 * Collapse a burst of scroll events into one call per animation frame.
 *
 * A scroll handler that re-derives a render window runs on every wheel tick
 * (dozens per second on a trackpad) and each run invalidates a computed the
 * renderer reads — so the work happened well ahead of anything being painted.
 * Coalescing to the frame does the same work once, right before the paint that
 * consumes it. Without `requestAnimationFrame` (SSR, jsdom) it degrades to
 * calling straight through, so behaviour never depends on the environment.
 */
export function createRafThrottle(fn: () => void): { schedule: () => void; cancel: () => void } {
	if (typeof requestAnimationFrame !== 'function') {
		return { schedule: fn, cancel: () => {} };
	}
	let handle: number | null = null;
	return {
		schedule() {
			if (handle !== null) return;
			handle = requestAnimationFrame(() => {
				handle = null;
				fn();
			});
		},
		cancel() {
			if (handle === null) return;
			cancelAnimationFrame(handle);
			handle = null;
		},
	};
}

/**
 * Per-folder scroll-position memory so returning from a thread restores the
 * list where it was. A module-level map (not component state) so it survives
 * the list component unmounting/remounting across route changes within a
 * session; it is intentionally not persisted across reloads.
 */
const scrollMemory = new Map<string, number>();
export function rememberScroll(key: string, top: number): void {
	scrollMemory.set(key, top);
}
export function recallScroll(key: string): number | undefined {
	return scrollMemory.get(key);
}

/**
 * The scroll container's live geometry: `scrollTop` synced from the element's
 * scroll events and `clientHeight` re-measured through a ResizeObserver.
 * Shared by the flat and the sectioned wrappers below — the plumbing is the
 * same, only the range math differs.
 */
function useScrollMetrics(scrollEl: Ref<HTMLElement | null>) {
	const scrollTop = ref(0);
	const viewportHeight = ref(0);

	function syncScroll() {
		const el = scrollEl.value;
		if (el) scrollTop.value = el.scrollTop;
	}
	function measure() {
		const el = scrollEl.value;
		if (el) viewportHeight.value = el.clientHeight;
	}

	let ro: ResizeObserver | undefined;
	onMounted(() => {
		const el = scrollEl.value;
		if (!el) return;
		measure();
		scrollTop.value = el.scrollTop;
		if (typeof ResizeObserver !== 'undefined') {
			ro = new ResizeObserver(() => measure());
			ro.observe(el);
		}
	});
	onBeforeUnmount(() => {
		ro?.disconnect();
	});

	return { scrollTop, viewportHeight, syncScroll, measure };
}

/**
 * Reactive wrapper: tracks the scroll container's scrollTop + viewport height
 * and derives the render window. When `enabled` is false (small folders) it
 * returns the full range so the caller renders every row unchanged.
 */
export function usePostboxVirtualList(opts: {
	scrollEl: Ref<HTMLElement | null>;
	itemCount: Ref<number>;
	rowHeight: Ref<number>;
	enabled: Ref<boolean>;
	overscan?: number;
}) {
	const overscan = opts.overscan ?? 10;
	const { scrollTop, viewportHeight, syncScroll, measure } = useScrollMetrics(opts.scrollEl);

	const range = computed<VirtualRange>(() => {
		if (!opts.enabled.value) {
			return {
				startIndex: 0,
				endIndex: opts.itemCount.value,
				offsetY: 0,
				totalHeight: opts.itemCount.value * opts.rowHeight.value,
			};
		}
		return computeVirtualRange({
			scrollTop: scrollTop.value,
			viewportHeight: viewportHeight.value,
			rowHeight: opts.rowHeight.value,
			itemCount: opts.itemCount.value,
			overscan,
		});
	});

	/** Shift the window (and the DOM scroll) so `index` is revealed. */
	function scrollToIndex(index: number) {
		const el = opts.scrollEl.value;
		if (!el) return;
		const next = scrollTopToRevealIndex({
			index,
			rowHeight: opts.rowHeight.value,
			scrollTop: el.scrollTop,
			viewportHeight: el.clientHeight,
		});
		if (next !== el.scrollTop) {
			el.scrollTop = next;
			scrollTop.value = next;
		}
	}

	return { range, scrollTop, viewportHeight, syncScroll, measure, scrollToIndex };
}

/**
 * The sectioned counterpart of {@link usePostboxVirtualList}, for the grouped
 * renderers. `sectionCounts` is the row count per section in render order (a
 * collapsed section contributes 0 rows and still costs its header), and the
 * returned windows are consumed as spacer/slice pairs so sticky headers keep
 * working.
 *
 * When `enabled` is false every section reports its full range, so a small
 * inbox renders exactly what it rendered before this existed.
 */
export function usePostboxSectionedVirtualList(opts: {
	scrollEl: Ref<HTMLElement | null>;
	sectionCounts: Ref<number[]>;
	rowHeight: Ref<number>;
	headerHeight: Ref<number>;
	enabled: Ref<boolean>;
	overscan?: number;
}) {
	const overscan = opts.overscan ?? 10;
	const { scrollTop, viewportHeight, syncScroll, measure } = useScrollMetrics(opts.scrollEl);

	const windows = computed<SectionWindow[]>(() => {
		if (!opts.enabled.value) {
			return opts.sectionCounts.value.map((count) => ({
				startIndex: 0,
				endIndex: count,
				padTop: 0,
				padBottom: 0,
			}));
		}
		return computeSectionedVirtualRanges({
			scrollTop: scrollTop.value,
			viewportHeight: viewportHeight.value,
			rowHeight: opts.rowHeight.value,
			headerHeight: opts.headerHeight.value,
			sectionCounts: opts.sectionCounts.value,
			overscan,
		}).sections;
	});

	/** Shift the scroll so the `flatIndex`-th row across all sections shows. */
	function scrollToFlatIndex(flatIndex: number) {
		const el = opts.scrollEl.value;
		if (!el) return;
		const next = scrollTopToRevealSectionedIndex({
			flatIndex,
			rowHeight: opts.rowHeight.value,
			headerHeight: opts.headerHeight.value,
			sectionCounts: opts.sectionCounts.value,
			scrollTop: el.scrollTop,
			viewportHeight: el.clientHeight,
		});
		if (next !== el.scrollTop) {
			el.scrollTop = next;
			scrollTop.value = next;
		}
	}

	return { windows, scrollTop, viewportHeight, syncScroll, measure, scrollToFlatIndex };
}
