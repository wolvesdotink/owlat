/**
 * Shared caret-rect measurement for the Postbox composer's caret-anchored
 * popovers (inline ghost-text overlay + `:shortcode:` emoji picker).
 *
 * Both surfaces need the collapsed selection's on-screen box translated into
 * coordinates relative to the scrolling editor surface, and both must fail soft
 * (return null → hide the affordance) rather than mis-place when the rect can't
 * be measured. The measurement is identical; only the anchor corner each caller
 * formats from differs, so it lives here once instead of being duplicated.
 */

/** The caret's box in surface-relative coordinates (px). */
export interface CaretRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
	height: number;
}

/**
 * Measure the current collapsed selection's caret rect relative to `surface`
 * (accounting for its scroll offset). Returns `null` — the callers' cue to hide
 * rather than mis-place — when there is no surface/selection or the rect is
 * unmeasurable (a zero-origin/zero-height box, e.g. an empty line or SSR).
 */
export function measureCaretRect(surface: HTMLElement | null): CaretRect | null {
	const sel = typeof window !== 'undefined' ? window.getSelection() : null;
	if (!surface || !sel || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0).cloneRange();
	range.collapse(false);
	const rects = range.getClientRects();
	const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
	if (!rect || (rect.top === 0 && rect.left === 0 && rect.height === 0)) return null;
	const host = surface.getBoundingClientRect();
	return {
		left: rect.left - host.left + surface.scrollLeft,
		top: rect.top - host.top + surface.scrollTop,
		right: rect.right - host.left + surface.scrollLeft,
		bottom: rect.bottom - host.top + surface.scrollTop,
		height: rect.height,
	};
}
