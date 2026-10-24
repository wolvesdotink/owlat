/**
 * What a `UiPopover` can be anchored to besides an element: a box with no
 * element of its own, like the caret in a text field.
 *
 * The positioning engine re-reads `getBoundingClientRect()` whenever the page
 * scrolls or resizes, so the box must answer in current viewport coordinates
 * every time it is asked. `contextElement` tells it which scroll containers to
 * watch.
 */
export interface VirtualAnchor {
	getBoundingClientRect(): DOMRect;
	contextElement?: Element;
}

export type PopoverAnchorTarget = Element | VirtualAnchor;

interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * A box measured once, in viewport coordinates, that then travels with
 * `element`: when the page or a container scrolls, the box moves by exactly as
 * much as the element did. A caret measured when a suggestion list opened
 * stays under its text this way, without measuring the selection again (by
 * then the selection may be somewhere else entirely).
 */
export function anchorToElementBox(element: Element, box: Box): VirtualAnchor {
	const origin = element.getBoundingClientRect();
	const dx = box.left - origin.left;
	const dy = box.top - origin.top;
	return {
		contextElement: element,
		getBoundingClientRect() {
			const now = element.getBoundingClientRect();
			return new DOMRect(now.left + dx, now.top + dy, box.width, box.height);
		},
	};
}

/**
 * The caret of the current selection inside `root` (a contenteditable), as a
 * box tied to `root`, or null when the selection is elsewhere or the browser
 * reports no geometry for it (an empty line can measure as a zero box at the
 * origin; anchoring to that would put the popover in the window's corner).
 */
export function selectionCaretAnchor(root: Element | null): VirtualAnchor | null {
	if (!root || typeof window === 'undefined') return null;
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return null;
	const range = selection.getRangeAt(0).cloneRange();
	if (!root.contains(range.endContainer)) return null;
	range.collapse(false);
	const rects = range.getClientRects();
	const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
	if (!rect || (rect.top === 0 && rect.left === 0 && rect.height === 0)) return null;
	return anchorToElementBox(root, {
		left: rect.left,
		top: rect.top,
		width: rect.width,
		height: rect.height,
	});
}
