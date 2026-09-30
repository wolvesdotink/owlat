/**
 * Pure geometry + placement helpers for the Postbox popup composer stack.
 *
 * Split out from the Vue components so the resize clamp and the
 * overflow→dock partition are unit-testable without mounting anything.
 */

/** A popup composer resize is clamped to these bounds. */
export const MIN_COMPOSER_WIDTH = 320;
export const MIN_COMPOSER_HEIGHT = 360;
/** Fraction of the viewport a composer may grow to at most. */
const MAX_COMPOSER_WIDTH_FRACTION = 0.9; // 90vw
const MAX_COMPOSER_HEIGHT_FRACTION = 0.85; // 85vh

/** Default popup composer size before the user drags to resize. */
export const DEFAULT_COMPOSER_SIZE: ComposerSize = { width: 380, height: 440 };

export interface ComposerSize {
	width: number;
	height: number;
}

export interface Viewport {
	width: number;
	height: number;
}

/**
 * Clamp a requested composer size to the min/max bounds. Width is clamped to
 * [320, 90vw] and height to [360, 85vh]; the upper bound never drops below the
 * lower one (a tiny viewport still yields the minimum, never an inverted range).
 * Non-finite inputs fall back to the minimum so a corrupt persisted value can't
 * blow up the layout.
 */
export function clampComposerSize(size: Partial<ComposerSize>, viewport: Viewport): ComposerSize {
	const maxW = Math.max(MIN_COMPOSER_WIDTH, viewport.width * MAX_COMPOSER_WIDTH_FRACTION);
	const maxH = Math.max(MIN_COMPOSER_HEIGHT, viewport.height * MAX_COMPOSER_HEIGHT_FRACTION);
	const w = Number.isFinite(size.width) ? (size.width as number) : MIN_COMPOSER_WIDTH;
	const h = Number.isFinite(size.height) ? (size.height as number) : MIN_COMPOSER_HEIGHT;
	return {
		width: Math.round(Math.min(Math.max(w, MIN_COMPOSER_WIDTH), maxW)),
		height: Math.round(Math.min(Math.max(h, MIN_COMPOSER_HEIGHT), maxH)),
	};
}

/**
 * Below Tailwind's `sm` a popup composer is a bottom sheet across the whole
 * width instead of a 320px-minimum box anchored bottom right: on a phone that
 * box ran off the left edge (its minimum is most of the screen) and covered
 * the content without using the rest.
 */
export const COMPOSER_SHEET_QUERY = '(max-width: 639.98px)';
/** Composers floating at once on a small screen: one sheet, the rest dock. */
export const SMALL_SCREEN_MAX_POPUPS = 1;

export interface PopupGeometry {
	mode: 'box' | 'sheet';
	style: Record<string, string>;
}

/**
 * Where a floating composer sits. A box keeps its persisted size, anchored
 * bottom right and moved left by its slot. A sheet spans the width and stands
 * on the on-screen keyboard (`keyboardInset`, px) with its top a little under
 * the status bar, so the page behind stays recognisable and Send stays above
 * the keyboard. With no keyboard its bottom clears the home indicator.
 */
export function popupComposerGeometry(input: {
	size: ComposerSize;
	slotIndex: number;
	sheet: boolean;
	keyboardInset: number;
}): PopupGeometry {
	const { size, slotIndex, sheet, keyboardInset } = input;
	if (!sheet) {
		return {
			mode: 'box',
			style: {
				width: `${size.width}px`,
				height: `${size.height}px`,
				right: `${24 + slotIndex * (size.width + 16)}px`,
				bottom: 'var(--pbx-composer-inset-bottom, 0px)',
			},
		};
	}
	const inset = Math.max(0, Math.round(keyboardInset));
	return {
		mode: 'sheet',
		style: {
			left: '0px',
			right: '0px',
			bottom: `${inset}px`,
			height: `calc(100dvh - var(--titlebar-h, 0px) - env(safe-area-inset-top, 0px) - 3rem - ${inset}px)`,
			paddingBottom: inset > 0 ? '0px' : 'env(safe-area-inset-bottom, 0px)',
		},
	};
}

/**
 * Placement of the open composers. Expanded (non-minimized) composers float as
 * popups anchored bottom-right, but only the most-recent `maxPopups` do so —
 * once three or more are open the overflow collapses into the bottom dock
 * alongside the minimized ones, instead of the old fixed pixel offset marching
 * each new popup further offscreen.
 *
 * `slot` is the right-to-left position of a floating popup (0 = rightmost /
 * newest). The dock preserves the original stack order.
 */
const MAX_POPUPS = 2;

export interface ComposerPlacement {
	popups: ReadonlyArray<{ id: string; slot: number }>;
	dock: ReadonlyArray<{ id: string }>;
}

export function layoutComposerStack(
	specs: ReadonlyArray<{ id: string; minimized: boolean }>,
	maxPopups: number = MAX_POPUPS
): ComposerPlacement {
	const expanded = specs.filter((s) => !s.minimized);
	// Keep the newest `maxPopups` expanded composers floating; everything else
	// (older expanded overflow + every minimized composer) docks.
	const kept = expanded.slice(-Math.max(0, maxPopups));
	const popupIds = new Set(kept.map((s) => s.id));

	const floating: string[] = [];
	const dock: { id: string }[] = [];
	for (const s of specs) {
		if (popupIds.has(s.id)) floating.push(s.id);
		else dock.push({ id: s.id });
	}

	const lastIndex = floating.length - 1;
	const popups = floating.map((id, i) => ({ id, slot: lastIndex - i }));
	return { popups, dock };
}
