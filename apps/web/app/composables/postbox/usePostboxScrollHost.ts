/**
 * DOM plumbing for a windowed list that does not own its scroll box.
 *
 * The Postbox thread list windows against its own `overflow: auto` box, which
 * only works where a parent gives it a bounded height. The Today column stacks
 * the list inside a taller scroller, and the contacts page lets the document
 * scroll, so there the list's own box is as tall as its rows, never scrolls,
 * and a window derived from it is the whole list. These helpers let the list
 * window against the scroller it actually sits in: find it, measure where the
 * list starts inside it, and follow its scroll and resize.
 *
 * When the document itself scrolls, the scroller is `document.scrollingElement`
 * (reads of scrollTop / scrollHeight / clientHeight work on it as on any
 * element), but its scroll and resize events fire on `window`.
 */
import { onBeforeUnmount, watch, type Ref } from 'vue';

/** True for the element that scrolls the page (its events fire on `window`). */
export function isDocumentScroller(el: Element): boolean {
	if (typeof document === 'undefined') return false;
	return el === document.scrollingElement || el === document.documentElement;
}

/**
 * The nearest ancestor element that scrolls vertically, or null when only the
 * document scrolls. Decided by computed `overflow-y`, not by current overflow,
 * so a container that is short right now (rows still loading) is still found.
 */
export function findOverflowAncestor(el: HTMLElement): HTMLElement | null {
	let node = el.parentElement;
	while (node && node !== document.body && node !== document.documentElement) {
		const overflowY = getComputedStyle(node).overflowY;
		if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return node;
		node = node.parentElement;
	}
	return null;
}

/** {@link findOverflowAncestor}, falling back to the document's scroller. */
export function findScrollParent(el: HTMLElement): HTMLElement {
	return (
		findOverflowAncestor(el) ??
		(document.scrollingElement as HTMLElement | null) ??
		document.documentElement
	);
}

/**
 * Pixel offset of `list`'s top edge within `scroller`'s scrollable content —
 * the scrollTop at which the list's first row reaches the scroller's top.
 */
export function measureListOffset(scroller: HTMLElement, list: HTMLElement): number {
	const listTop = list.getBoundingClientRect().top;
	const hostTop = isDocumentScroller(scroller)
		? 0
		: scroller.getBoundingClientRect().top + scroller.clientTop;
	return listTop - hostTop + scroller.scrollTop;
}

/**
 * Call `onResize` when the scroller's viewport changes size. An element is
 * watched with a ResizeObserver; the document's viewport is the window, whose
 * size a ResizeObserver on <html> does not report. Returns the teardown.
 */
export function observeViewport(el: HTMLElement, onResize: () => void): () => void {
	if (isDocumentScroller(el)) {
		window.addEventListener('resize', onResize, { passive: true });
		return () => window.removeEventListener('resize', onResize);
	}
	if (typeof ResizeObserver === 'undefined') return () => {};
	const ro = new ResizeObserver(() => onResize());
	ro.observe(el);
	return () => ro.disconnect();
}

/**
 * Bind `handler` to the scroll events of whatever `target` currently holds
 * (re-binding when it changes, unbinding on unmount): the element's own event,
 * or `window`'s when the document is the scroller. Passive — windowing never
 * cancels a scroll.
 */
export function usePostboxScrollEvent(target: Ref<HTMLElement | null>, handler: () => void): void {
	let unbind: (() => void) | undefined;
	watch(
		target,
		(el) => {
			unbind?.();
			unbind = undefined;
			if (!el) return;
			const source: EventTarget = isDocumentScroller(el) ? window : el;
			const listener = () => handler();
			source.addEventListener('scroll', listener, { passive: true });
			unbind = () => source.removeEventListener('scroll', listener);
		},
		{ immediate: true, flush: 'post' }
	);
	onBeforeUnmount(() => unbind?.());
}
