import {
	computed,
	nextTick,
	onBeforeUnmount,
	onMounted,
	shallowRef,
	toValue,
	watch,
	type ComponentPublicInstance,
	type ComputedRef,
	type MaybeRefOrGetter,
	type Ref,
} from 'vue';
import {
	buildVirtualListLayout,
	captureVirtualListAnchors,
	restoreVirtualListAnchor,
	virtualListHeight,
	virtualRowRange,
	virtualRowSize,
	type VirtualListAnchor,
	type VirtualListLayout,
} from './virtualListLayout';

export interface VirtualListOptions<T> {
	/** The rows, in render order. */
	items: MaybeRefOrGetter<readonly T[]>;
	/**
	 * Stable identity of a row. Measured heights and the scroll anchor follow
	 * the key, so it must not change when the row's content does.
	 */
	getKey: (item: T) => string;
	/** Height to assume for a row that has not been on screen yet, in px. */
	estimateSize: (item: T) => number;
	/**
	 * The scrolling element. The list's spacers and rows must be its content,
	 * with nothing above them but the element's own top padding.
	 */
	scrollerRef: Ref<HTMLElement | null>;
	/** How far above and below the viewport rows stay mounted, in px. */
	overscanPx?: number;
	/**
	 * Open at the end, and keep a reader who is there at the end while rows
	 * change height (a streamed reply, an image loading, a narrower window).
	 */
	stickToEnd?: boolean;
	/** How close to the end still counts as being there, in px. */
	endThresholdPx?: number;
	/** Keys of rows that must stay mounted out of view, e.g. one being edited. */
	keepMounted?: MaybeRefOrGetter<Iterable<string>>;
}

export interface VirtualListRow<T> {
	item: T;
	key: string;
	index: number;
	/**
	 * Height of the unmounted rows between this row and the previous rendered
	 * one. Non-zero only around a row kept mounted out of view.
	 */
	gapBefore: number;
}

type RowRef = (el: Element | ComponentPublicInstance | null) => void;

/** Assumed viewport height before the scroller has been measured. */
const INITIAL_VIEWPORT_PX = 800;

function borderBlockSize(entry: ResizeObserverEntry): number {
	const box = entry.borderBoxSize as ResizeObserverSize[] | ResizeObserverSize | undefined;
	const size = Array.isArray(box) ? box[0] : box;
	return size ? size.blockSize : entry.target.getBoundingClientRect().height;
}

/**
 * Variable-height windowing for a vertical list inside its own scroller.
 *
 * Only the rows near the viewport are mounted; two spacers stand in for the
 * rest. Every mounted row is measured with a ResizeObserver and its height is
 * cached by key, so the spacers converge on the real list height as the reader
 * scrolls, and rows never seen are sized by `estimateSize`.
 *
 * The scroll position is anchored to a visible row: when rows above it are
 * measured, change height, or are inserted or removed, `scrollTop` moves by the
 * same amount and what the reader is looking at stays put. Native scroll
 * anchoring is switched off on the scroller, or both would correct the same
 * change. With `stickToEnd`, a reader at the end stays at the end instead.
 *
 * New rows at the end are not followed automatically: whether a new row pulls
 * the view down is the caller's decision (see `scrollToEnd`).
 */
export function useVirtualList<T>(options: VirtualListOptions<T>) {
	const { getKey, estimateSize, scrollerRef } = options;
	const overscanPx = options.overscanPx ?? 600;
	const stickToEnd = options.stickToEnd ?? false;
	const endThresholdPx = options.endThresholdPx ?? 80;

	// Measured border-box heights by row key, pruned to the current rows.
	const sizes = new Map<string, number>();
	const sizesVersion = shallowRef(0);
	const scrollTop = shallowRef(stickToEnd ? Number.POSITIVE_INFINITY : 0);
	const viewportHeight = shallowRef(INITIAL_VIEWPORT_PX);
	const listOffset = shallowRef(0);
	// The same two values as last read from the DOM. Measurement updates the
	// refs a frame later (see `commitMeasurements`) but corrects the scroll
	// position at once, from these.
	let knownViewport = INITIAL_VIEWPORT_PX;
	let knownListOffset = 0;
	const focusedKey = shallowRef<string | null>(null);
	// Reading the latest rows: set at the end, cleared only by scrolling up, so
	// content growing below the reader does not count as them leaving.
	let pinned = stickToEnd;
	let lastScrollTop = 0;
	// A smooth `scrollToEnd` is under way: a correction retargets it instead of
	// cutting it short with a jump.
	let seekingEnd = false;

	const layoutOf = (items: readonly T[]): VirtualListLayout => {
		const keys = items.map(getKey);
		return buildVirtualListLayout(keys, (i) => sizes.get(keys[i]!) ?? estimateSize(items[i]!));
	};

	const layout = computed(() => {
		void sizesVersion.value;
		return layoutOf(toValue(options.items));
	});

	const windowTop = computed(() => {
		const max = Math.max(0, virtualListHeight(layout.value) - viewportHeight.value);
		return Math.min(Math.max(0, scrollTop.value - listOffset.value), max);
	});
	const range = computed(() =>
		virtualRowRange(layout.value, windowTop.value, viewportHeight.value, overscanPx)
	);
	// Primitive computeds, so a scroll that stays inside the same rows does not
	// re-render the list.
	const startIndex = computed(() => range.value.start);
	const endIndex = computed(() => range.value.end);

	const keptIndexes = computed(() => {
		const lay = layout.value;
		const kept = new Set<number>();
		const add = (key: string | null) => {
			const index = key === null ? undefined : lay.indexOf.get(key);
			if (index !== undefined) kept.add(index);
		};
		for (const key of toValue(options.keepMounted) ?? []) add(key);
		add(focusedKey.value);
		return kept;
	});

	const view = computed(() => {
		const lay = layout.value;
		const items = toValue(options.items);
		const start = startIndex.value;
		const end = endIndex.value;
		const extra = [...keptIndexes.value].filter((i) => i < start || i >= end);
		const indexes = [
			...extra.filter((i) => i < start).sort((a, b) => a - b),
			...Array.from({ length: end - start }, (_, k) => start + k),
			...extra.filter((i) => i >= end).sort((a, b) => a - b),
		];
		const rows: VirtualListRow<T>[] = [];
		let cursor = indexes.length > 0 ? lay.starts[indexes[0]!]! : 0;
		const paddingTop = cursor;
		for (const index of indexes) {
			const top = lay.starts[index]!;
			rows.push({ item: items[index]!, key: lay.keys[index]!, index, gapBefore: top - cursor });
			cursor = lay.starts[index + 1]!;
		}
		return { rows, paddingTop, paddingBottom: virtualListHeight(lay) - cursor };
	});

	// --- Measurement -----------------------------------------------------------

	const keyOf = new WeakMap<Element, string>();
	const elementOf = new Map<string, Element>();
	const rowRefs = new Map<string, RowRef>();
	let observer: ResizeObserver | null = null;

	const ensureObserver = (): ResizeObserver | null => {
		if (!observer && typeof ResizeObserver === 'function') {
			observer = new ResizeObserver(onResize);
		}
		return observer;
	};

	/**
	 * Template ref for a row. One callback per key, so Vue does not detach and
	 * re-attach the row on every render.
	 */
	const measure = (key: string): RowRef => {
		let ref = rowRefs.get(key);
		if (ref) return ref;
		ref = (target) => {
			const el = target && '$el' in target ? (target.$el as Element | null) : target;
			const previous = elementOf.get(key);
			if (previous === el) return;
			if (previous) {
				observer?.unobserve(previous);
				keyOf.delete(previous);
				elementOf.delete(key);
			}
			if (el instanceof Element) {
				elementOf.set(key, el);
				keyOf.set(el, key);
				ensureObserver()?.observe(el);
			}
		};
		rowRefs.set(key, ref);
		return ref;
	};

	const readListOffset = (el: HTMLElement): number =>
		typeof getComputedStyle === 'function' ? parseFloat(getComputedStyle(el).paddingTop) || 0 : 0;

	const setScrollTop = (el: HTMLElement, top: number) => {
		el.scrollTop = top;
		scrollTop.value = el.scrollTop;
	};

	// Reactive updates from a ResizeObserver callback wait for the next frame.
	// Applied inside the callback, Vue would re-render in its microtask, mount
	// rows the observer has not delivered yet, and the browser would report a
	// "ResizeObserver loop completed with undelivered notifications" error.
	// The scroll correction itself is a plain DOM write and happens at once,
	// before the frame is painted.
	let frame: number | null = null;
	const commitMeasurements = () => {
		frame = null;
		sizesVersion.value += 1;
		viewportHeight.value = knownViewport;
		listOffset.value = knownListOffset;
		const el = scrollerRef.value;
		if (el) scrollTop.value = el.scrollTop;
	};
	const scheduleCommit = () => {
		if (frame !== null) return;
		frame =
			typeof requestAnimationFrame === 'function'
				? requestAnimationFrame(commitMeasurements)
				: (setTimeout(commitMeasurements, 0) as unknown as number);
	};
	const cancelCommit = () => {
		if (frame === null) return;
		if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
		else clearTimeout(frame);
		frame = null;
	};

	function onResize(entries: ResizeObserverEntry[]) {
		const el = scrollerRef.value;
		if (!el) return;
		const items = toValue(options.items);
		// The geometry last painted: measured rows at their cached height, rows
		// mounted since then still at their estimate.
		const before = layoutOf(items);
		const prevViewport = knownViewport;
		const prevScrollTop = el.scrollTop;
		const viewTop = prevScrollTop - knownListOffset;
		let changed = false;
		let affectsView = false;
		for (const entry of entries) {
			if (entry.target === el) {
				knownViewport = el.clientHeight;
				knownListOffset = readListOffset(el);
				changed = true;
				if (knownViewport !== prevViewport) affectsView = true;
				continue;
			}
			const key = keyOf.get(entry.target);
			const index = key === undefined ? undefined : before.indexOf.get(key);
			if (key === undefined || index === undefined || !entry.target.isConnected) continue;
			const size = borderBlockSize(entry);
			sizes.set(key, size);
			if (Math.abs(size - virtualRowSize(before, index)) < 0.5) continue;
			changed = true;
			// A row wholly below the viewport moves nothing the reader can see.
			if (before.starts[index]! < viewTop + prevViewport) affectsView = true;
		}
		if (!changed) return;
		scheduleCommit();
		if (!affectsView) return;
		if (pinned) {
			if (seekingEnd) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
			else el.scrollTop = el.scrollHeight;
			return;
		}
		const anchors = captureVirtualListAnchors(before, viewTop, prevViewport);
		const target = restoreVirtualListAnchor(layoutOf(items), anchors);
		if (target === null) return;
		const top = target + knownListOffset;
		if (Math.abs(top - prevScrollTop) >= 0.5) el.scrollTop = top;
	}

	// --- Rows inserted or removed ----------------------------------------------

	// Applied once the re-render is in the DOM, before the browser paints it.
	let pendingScroll: number | 'end' | null = null;
	const applyPendingScroll = () => {
		const el = scrollerRef.value;
		if (el && pendingScroll !== null) {
			setScrollTop(el, pendingScroll === 'end' ? el.scrollHeight : pendingScroll);
		}
		pendingScroll = null;
	};

	// Runs before the list re-renders: the anchor is taken from the geometry
	// the reader last saw, and the new window is rendered at the corrected
	// position instead of flashing the old one first.
	watch(
		() => toValue(options.items),
		(next, prev) => {
			const el = scrollerRef.value;
			const nextKeys = new Set(next.map(getKey));
			const prevItems = prev ?? [];
			const fresh = !prevItems.some((item) => nextKeys.has(getKey(item)));
			let anchors: VirtualListAnchor[] = [];
			if (el && !fresh) {
				anchors = captureVirtualListAnchors(
					layoutOf(prevItems),
					el.scrollTop - knownListOffset,
					knownViewport
				);
			}
			for (const key of sizes.keys()) if (!nextKeys.has(key)) sizes.delete(key);
			for (const key of rowRefs.keys()) if (!nextKeys.has(key)) rowRefs.delete(key);
			if (!el) return;
			if (fresh) {
				// A list whose rows were all replaced is a new list: open it at the end.
				if (!stickToEnd || next.length === 0) return;
				pinned = true;
				scrollTop.value = Number.POSITIVE_INFINITY;
				pendingScroll = 'end';
				void nextTick(applyPendingScroll);
				return;
			}
			const target = restoreVirtualListAnchor(layoutOf(next), anchors);
			if (target === null) return;
			const top = target + knownListOffset;
			if (Math.abs(top - el.scrollTop) < 0.5) return;
			scrollTop.value = top;
			pendingScroll = top;
			void nextTick(applyPendingScroll);
		},
		{ flush: 'pre' }
	);

	// --- Scroll and focus ------------------------------------------------------

	const distanceFromEnd = (): number => {
		const el = scrollerRef.value;
		return el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0;
	};

	const onScroll = () => {
		const el = scrollerRef.value;
		if (!el) return;
		scrollTop.value = el.scrollTop;
		const distance = distanceFromEnd();
		if (distance <= 1) seekingEnd = false;
		if (distance <= endThresholdPx) pinned = stickToEnd;
		else if (el.scrollTop < lastScrollTop) {
			pinned = false;
			seekingEnd = false;
		}
		lastScrollTop = el.scrollTop;
	};

	/**
	 * Scroll to the last row. A smooth scroll only when the rows on the way are
	 * mounted: through unmeasured rows it would aim at estimated heights and
	 * stop short, so a longer trip jumps.
	 */
	const scrollToEnd = (behavior: ScrollBehavior = 'auto') => {
		const el = scrollerRef.value;
		if (!el) return;
		pinned = stickToEnd;
		const far = distanceFromEnd() > overscanPx;
		const resolved: ScrollBehavior = far ? 'auto' : behavior;
		seekingEnd = stickToEnd && resolved === 'smooth';
		el.scrollTo({ top: el.scrollHeight, behavior: resolved });
		if (resolved !== 'smooth') scrollTop.value = el.scrollTop;
	};

	const rowKeyOf = (target: EventTarget | null): string | null => {
		const root = scrollerRef.value;
		let node = target instanceof Node ? target : null;
		while (node && node !== root) {
			const key = node instanceof Element ? keyOf.get(node) : undefined;
			if (key !== undefined) return key;
			node = node.parentNode;
		}
		return null;
	};
	// A focused row stays mounted, so scrolling away does not drop keyboard focus.
	const onFocusIn = (event: FocusEvent) => {
		focusedKey.value = rowKeyOf(event.target);
	};
	const onFocusOut = (event: FocusEvent) => {
		// Null when the window loses focus: the row keeps it for when it returns.
		if (event.relatedTarget) focusedKey.value = rowKeyOf(event.relatedTarget);
	};

	let mountedEl: HTMLElement | null = null;
	onMounted(() => {
		const el = scrollerRef.value;
		if (!el) return;
		mountedEl = el;
		el.style.overflowAnchor = 'none';
		knownViewport = el.clientHeight;
		knownListOffset = readListOffset(el);
		viewportHeight.value = knownViewport;
		listOffset.value = knownListOffset;
		el.addEventListener('scroll', onScroll, { passive: true });
		el.addEventListener('focusin', onFocusIn);
		el.addEventListener('focusout', onFocusOut);
		ensureObserver()?.observe(el);
		if (stickToEnd) scrollToEnd('auto');
		else scrollTop.value = el.scrollTop;
		lastScrollTop = el.scrollTop;
	});

	onBeforeUnmount(() => {
		mountedEl?.removeEventListener('scroll', onScroll);
		mountedEl?.removeEventListener('focusin', onFocusIn);
		mountedEl?.removeEventListener('focusout', onFocusOut);
		mountedEl = null;
		observer?.disconnect();
		observer = null;
		cancelCommit();
		elementOf.clear();
		rowRefs.clear();
		pendingScroll = null;
	});

	// The previous array when nothing a row renders changed (a re-measure that
	// left the window alone), so the list does not re-render for it.
	const rows: ComputedRef<VirtualListRow<T>[]> = computed((previous) => {
		const next = view.value.rows;
		if (!previous || previous.length !== next.length) return next;
		for (let i = 0; i < next.length; i++) {
			const a = previous[i]!;
			const b = next[i]!;
			if (
				a.key !== b.key ||
				a.item !== b.item ||
				a.index !== b.index ||
				a.gapBefore !== b.gapBefore
			) {
				return next;
			}
		}
		return previous;
	});
	const paddingTop = computed(() => view.value.paddingTop);
	const paddingBottom = computed(() => view.value.paddingBottom);

	return { rows, paddingTop, paddingBottom, measure, distanceFromEnd, scrollToEnd };
}
