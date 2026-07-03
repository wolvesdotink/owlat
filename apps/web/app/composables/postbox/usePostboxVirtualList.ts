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
 * Given a target row index, return the `scrollTop` that brings it fully into
 * view with "nearest" semantics: scroll up if it's above the viewport, down if
 * it's below, otherwise leave the position untouched. Used to keep the
 * keyboard-focused row visible even when it isn't currently mounted.
 */
export function scrollTopToRevealIndex(o: {
	index: number;
	rowHeight: number;
	scrollTop: number;
	viewportHeight: number;
}): number {
	const rowTop = o.index * o.rowHeight;
	const rowBottom = rowTop + o.rowHeight;
	if (rowTop < o.scrollTop) return rowTop;
	if (rowBottom > o.scrollTop + o.viewportHeight) return rowBottom - o.viewportHeight;
	return o.scrollTop;
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
	const scrollTop = ref(0);
	const viewportHeight = ref(0);

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

	function syncScroll() {
		const el = opts.scrollEl.value;
		if (el) scrollTop.value = el.scrollTop;
	}
	function measure() {
		const el = opts.scrollEl.value;
		if (el) viewportHeight.value = el.clientHeight;
	}

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

	let ro: ResizeObserver | undefined;
	onMounted(() => {
		const el = opts.scrollEl.value;
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

	return { range, scrollTop, viewportHeight, syncScroll, measure, scrollToIndex };
}
