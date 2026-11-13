/**
 * Geometry for the reader's sticky bar: when the conversation's header has
 * scrolled out from under it, and how tall the host's own sticky bar above it
 * is.
 *
 * The bar sits in a zero-height sticky anchor at the top of the article, so it
 * overlays the conversation instead of pushing it down. While the header is on
 * screen the anchor sits above it; once the anchor sticks, it marks the line
 * the bar covers from. The header counts as gone when its bottom edge has
 * passed that line, which needs no knowledge of the scroller or of what the
 * host stacks above the reader.
 */
import { ref, watch, type Ref } from 'vue';
import { findScrollParent, usePostboxScrollEvent } from './usePostboxScrollHost';

/** Whether the header's bottom edge is at or above the sticky anchor. */
export function isHeaderScrolledPast(header: HTMLElement, anchor: HTMLElement): boolean {
	return header.getBoundingClientRect().bottom <= anchor.getBoundingClientRect().top;
}

/**
 * True while `header` has scrolled past `anchor`. Measured when both bind and
 * on every scroll of the anchor's scroller.
 */
export function useHeaderScrolledPast(
	header: Ref<HTMLElement | null>,
	anchor: Ref<HTMLElement | null>
): Ref<boolean> {
	const past = ref(false);
	const scroller = ref<HTMLElement | null>(null);
	function measure() {
		past.value =
			!!header.value && !!anchor.value && isHeaderScrolledPast(header.value, anchor.value);
	}
	watch(
		[header, anchor],
		([, el]) => {
			scroller.value = el ? findScrollParent(el) : null;
			measure();
		},
		{ immediate: true, flush: 'post' }
	);
	usePostboxScrollEvent(scroller, measure);
	return past;
}
