/**
 * Postbox reading-pane layout — where the reader sits relative to the message
 * list, and how big the list pane is.
 *
 * The three panes used to have ONE hardcoded geometry: a 384px list on the
 * left, the reader filling whatever was left, at every width. On a wide monitor
 * that hands the reader a 1400px measure (a line-length problem); on a laptop
 * the list truncates every subject; and there was no way to move the seam.
 *
 *   - 'right'  → today's side-by-side layout, now with a resizable list WIDTH.
 *                The default, so an unset preference is exactly the geometry
 *                that shipped before this control existed.
 *   - 'bottom' → a full-width list on top with the reader below it, sized by a
 *                resizable list HEIGHT. Wide rows, short preview.
 *   - 'off'    → no reading pane at all: the list takes the full width and
 *                opening a message navigates to the reader (the drill-in the
 *                narrow layout has always used, applied at every width).
 *
 * The pane is applied as a single `data-reading-pane` attribute on the Postbox
 * root and the seam position as one `--pbx-list-width` / `--pbx-list-height`
 * custom property, so the geometry lives in CSS (postbox-panes.css) exactly the
 * way density does — components never re-implement it.
 *
 * Everything decidable without a component is decided here, so the clamping,
 * the keyboard nudges and the pane→geometry mapping are unit-testable without
 * mounting the Convex-backed layout.
 */

export type PostboxReadingPane = 'right' | 'bottom' | 'off';

export const POSTBOX_READING_PANE_DEFAULT: PostboxReadingPane = 'right';

/**
 * The picker options. Module scope never calls `useI18n`, so `label` is the
 * catalog key the settings screen renders through `t()`.
 */
export const POSTBOX_READING_PANE_OPTIONS: Array<{
	value: PostboxReadingPane;
	label: string;
}> = [
	{ value: 'right', label: 'shared.postboxReadingPane.right' },
	{ value: 'bottom', label: 'shared.postboxReadingPane.bottom' },
	{ value: 'off', label: 'shared.postboxReadingPane.off' },
];

/** Normalise a stored/unknown value to a valid pane, defaulting safely. */
export function resolvePostboxReadingPane(value: string | undefined | null): PostboxReadingPane {
	return value === 'bottom' || value === 'off' ? value : POSTBOX_READING_PANE_DEFAULT;
}

/**
 * Which dimension of the list pane the divider moves. A pane without a divider
 * ('off' — there is no second pane to take space from) reports `null`.
 */
export type PostboxPaneAxis = 'width' | 'height';

/**
 * Per-axis bounds for the list pane, in CSS pixels.
 *
 * The width default is 384px — `lg:w-96`, the exact hardcoded value the layout
 * had — so a user who never drags the handle sees no change at all. The minimum
 * is the narrowest a row stays readable at; the maximum keeps the reader wider
 * than the list on a 1280px laptop, which is the whole point of the pane.
 */
export const POSTBOX_LIST_SIZE_LIMITS: Record<
	PostboxPaneAxis,
	{ min: number; max: number; default: number }
> = {
	width: { min: 280, max: 720, default: 384 },
	height: { min: 200, max: 640, default: 320 },
};

/** One arrow-key press. Shift/PageUp take {@link POSTBOX_LIST_SIZE_COARSE_STEP}. */
export const POSTBOX_LIST_SIZE_STEP = 16;
export const POSTBOX_LIST_SIZE_COARSE_STEP = 64;

/**
 * Clamp a candidate size into the axis' bounds, rounded to whole pixels. A
 * non-finite value (a corrupt row, a NaN out of a pointer event) resolves to
 * the axis default rather than propagating: a broken width is a broken layout.
 */
export function clampPostboxListSize(value: number, axis: PostboxPaneAxis): number {
	const limits = POSTBOX_LIST_SIZE_LIMITS[axis];
	if (!Number.isFinite(value)) return limits.default;
	return Math.min(limits.max, Math.max(limits.min, Math.round(value)));
}

/**
 * Normalise a STORED size. Absent (never dragged) resolves to the axis default,
 * which for the width is the geometry that shipped before the handle existed.
 */
export function resolvePostboxListSize(
	value: number | undefined | null,
	axis: PostboxPaneAxis
): number {
	if (value === undefined || value === null) return POSTBOX_LIST_SIZE_LIMITS[axis].default;
	return clampPostboxListSize(value, axis);
}

/**
 * The size an arrow key moves to. `delta` is signed pixels (already coarse or
 * fine); the result is clamped, so holding a key at either bound is a no-op
 * rather than an accumulating out-of-range number.
 */
export function nudgePostboxListSize(
	current: number,
	delta: number,
	axis: PostboxPaneAxis
): number {
	return clampPostboxListSize(clampPostboxListSize(current, axis) + delta, axis);
}

/**
 * How far one key press moves the divider: fine by default, coarse with Shift
 * (and on PageUp/PageDown), matching the WAI-ARIA window-splitter pattern.
 */
export function postboxListSizeStep(coarse: boolean): number {
	return coarse ? POSTBOX_LIST_SIZE_COARSE_STEP : POSTBOX_LIST_SIZE_STEP;
}

export interface PostboxPaneGeometry {
	/** How the list and reader stack at `lg` and up. */
	stack: 'row' | 'column';
	/** The dimension the divider resizes, or `null` when there is no divider. */
	axis: PostboxPaneAxis | null;
	/**
	 * Does the list stay on screen while a message is open (at `lg` and up)?
	 * False for 'off', where opening a message navigates to a full-width reader
	 * exactly like the narrow drill-in.
	 */
	keepsListWhileReading: boolean;
}

/** The pane's geometry, as the layout and the resizer both read it. */
export function postboxPaneGeometry(pane: PostboxReadingPane): PostboxPaneGeometry {
	if (pane === 'bottom') return { stack: 'column', axis: 'height', keepsListWhileReading: true };
	if (pane === 'off') return { stack: 'row', axis: null, keepsListWhileReading: false };
	return { stack: 'row', axis: 'width', keepsListWhileReading: true };
}

/**
 * The custom properties the Postbox root publishes for postbox-panes.css. Both
 * are always emitted (they cost nothing and keep the style object a stable
 * shape); the stylesheet reads whichever one the active pane needs.
 */
export function postboxPaneStyle(width: number, height: number): Record<string, string> {
	return {
		'--pbx-list-width': `${clampPostboxListSize(width, 'width')}px`,
		'--pbx-list-height': `${clampPostboxListSize(height, 'height')}px`,
	};
}

/**
 * Turn a pointer position into a list size. `origin` is the list pane's own
 * leading edge (its `left` for a width drag, its `top` for a height drag), so
 * the size is simply how far past it the pointer sits — no drag-start bookkeeping
 * and no drift when the window resizes mid-drag.
 */
export function postboxListSizeFromPointer(
	pointer: number,
	origin: number,
	axis: PostboxPaneAxis
): number {
	return clampPostboxListSize(pointer - origin, axis);
}
