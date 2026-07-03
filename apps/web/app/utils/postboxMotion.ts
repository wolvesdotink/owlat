/**
 * One motion vocabulary for the Postbox.
 *
 * A single source of truth for durations, easing and reduced-motion behaviour
 * so every Postbox transition (reader-pane swap, folder-change list fade,
 * composer popup, hover reveals, toasts, dialogs) moves the same way.
 *
 * The matching CSS lives in `assets/css/postbox-motion.css` (Vue `<Transition>`
 * class groups + the `--pbx-motion-*` custom properties + the global
 * `prefers-reduced-motion` reduction). This module is the JS half: it exposes
 * the same tokens as constants and the runtime helpers (reduced-motion probe +
 * a View Transitions wrapper for the reader swap). Keep the two in sync.
 */

/** Transition durations, in milliseconds. */
export const MOTION_DURATION = {
	/** Fast: content swaps, hover reveals, toasts. */
	fast: 160,
	/** Panel: popups and dialogs opening/closing. */
	panel: 220,
} as const;

/** The single standard easing curve for every Postbox transition. */
export const MOTION_EASE = 'cubic-bezier(0.2, 0, 0, 1)';

/** The CSS-custom-property names the stylesheet reads (kept in sync here). */
export const MOTION_VARS = {
	fast: '--pbx-motion-fast',
	panel: '--pbx-motion-panel',
	ease: '--pbx-motion-ease',
} as const;

export type MotionSpeed = keyof typeof MOTION_DURATION;

/**
 * True when the user (or platform) has asked for reduced motion.
 *
 * SSR-safe: returns `false` when `window`/`matchMedia` are unavailable so the
 * server render never assumes a preference. On the client, honours the live
 * `prefers-reduced-motion: reduce` media query.
 */
export function prefersReducedMotion(): boolean {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
		return false;
	}
	try {
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	} catch {
		return false;
	}
}

/**
 * Resolve a motion duration for the given speed, collapsing to `0` when the
 * user prefers reduced motion. Use for JS-driven animations that cannot rely on
 * the CSS media query (the CSS class groups already reduce themselves).
 */
export function motionDuration(speed: MotionSpeed, reduced = prefersReducedMotion()): number {
	return reduced ? 0 : MOTION_DURATION[speed];
}

/** A minimal structural type for the View Transitions API we rely on. */
type ViewTransitionCapableDocument = Document & {
	startViewTransition?: (callback: () => void | Promise<void>) => unknown;
};

/**
 * Run a DOM-mutating callback inside the View Transitions API when it is
 * trivially applicable (supported + motion not reduced), else just run the
 * callback so the Vue `<Transition>` fallback handles the visuals.
 *
 * Feature-detected and fail-soft: any thrown error still runs `apply()` so the
 * reader never gets stuck mid-swap. Both paths honour reduced motion.
 */
export function startReaderViewTransition(
	apply: () => void,
	reduced = prefersReducedMotion(),
): void {
	const doc =
		typeof document === 'undefined'
			? undefined
			: (document as ViewTransitionCapableDocument);
	if (reduced || !doc || typeof doc.startViewTransition !== 'function') {
		apply();
		return;
	}
	try {
		doc.startViewTransition(apply);
	} catch {
		apply();
	}
}
