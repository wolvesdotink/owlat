/**
 * The scroll half of every Postbox list renderer: grow the page before the
 * user reaches the bottom, and do the per-frame bookkeeping the windowed
 * render depends on.
 *
 * All three renderers (flat, conversation, categories) had the same handler
 * inline — a scroll listener that synced the window, remembered the position
 * and fired "load more" near the end, guarded so a page in flight is never
 * asked for twice. This is that handler, once, with the range math left to
 * usePostboxVirtualList and the near-end predicate + frame coalescing to its
 * pure helpers.
 */
import type { Ref } from 'vue';
import { createRafThrottle, isNearListEnd } from './usePostboxVirtualList';

/** How close to the end (in px) the scroll gets before the next page is asked for. */
export const POSTBOX_AUTOLOAD_MARGIN_PX = 240;

export function usePostboxListAutoLoad(opts: {
	scrollEl: Ref<HTMLElement | null>;
	/** Rows currently rendered — the guard's re-arm signal when a page lands. */
	itemCount: Ref<number>;
	/** A further page exists AND there is a cursor to reach it. */
	hasMore: Ref<boolean>;
	/** True while a load is already in flight (first page or "load more"). */
	blocked: Ref<boolean>;
	/** Per-frame side effects the caller owns (window sync, scroll memory). */
	onScroll?: (el: HTMLElement) => void;
	loadMore: () => void;
	marginPx?: number;
}) {
	const marginPx = opts.marginPx ?? POSTBOX_AUTOLOAD_MARGIN_PX;
	// One emit per row count: a load in flight is never spammed, and the count
	// changing (the page landed) is what re-arms the trigger.
	let emittedForCount = -1;

	function readScroll() {
		const el = opts.scrollEl.value;
		if (!el) return;
		opts.onScroll?.(el);
		if (!opts.hasMore.value || opts.blocked.value) return;
		if (emittedForCount === opts.itemCount.value) return;
		if (
			!isNearListEnd({
				scrollTop: el.scrollTop,
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
				marginPx,
			})
		) {
			return;
		}
		emittedForCount = opts.itemCount.value;
		opts.loadMore();
	}

	const throttle = createRafThrottle(readScroll);
	onBeforeUnmount(() => throttle.cancel());

	/** Attach to the scroll container's `@scroll`. */
	return { handleScroll: throttle.schedule };
}
