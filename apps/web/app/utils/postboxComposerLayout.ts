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
export const MAX_COMPOSER_WIDTH_FRACTION = 0.9; // 90vw
export const MAX_COMPOSER_HEIGHT_FRACTION = 0.85; // 85vh

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
 * Placement of the open composers. Expanded (non-minimized) composers float as
 * popups anchored bottom-right, but only the most-recent `maxPopups` do so —
 * once three or more are open the overflow collapses into the bottom dock
 * alongside the minimized ones, instead of the old fixed pixel offset marching
 * each new popup further offscreen.
 *
 * `slot` is the right-to-left position of a floating popup (0 = rightmost /
 * newest). The dock preserves the original stack order.
 */
export const MAX_POPUPS = 2;

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
	const popupIds = new Set(expanded.slice(-Math.max(0, maxPopups)).map((s) => s.id));

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
