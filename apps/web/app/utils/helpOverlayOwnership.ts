/**
 * Who owns the "?" cheat sheet.
 *
 * Two independent listeners answer "?": the app-wide one in
 * `useKeyboardShortcuts` (a document listener behind KeyboardShortcutsHelp) and
 * the Postbox one in PostboxShortcutHelp (a window listener over the Postbox
 * key map). On a Postbox route both fired, so a single "?" opened two overlays
 * stacked on top of each other.
 *
 * A surface that ships its own, more specific cheat sheet claims ownership
 * while it is mounted; the app-wide listener stands down for as long as any
 * claim is held. A counter rather than a boolean: two claiming surfaces can
 * overlap for a tick during a route change, and the first unmount must not hand
 * the key back while the second still owns it.
 *
 * Module-scope, not reactive: the only reader is a keydown handler, which runs
 * long after any render.
 */

let claims = 0;

/**
 * Claim the "?" key for a surface with its own cheat sheet. Returns the release
 * function — idempotent, so an unmount path that runs twice cannot under-count.
 */
export function claimHelpOverlay(): () => void {
	claims += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		claims = Math.max(0, claims - 1);
	};
}

/** True while a mounted surface owns "?" — the app-wide overlay stays shut. */
export function isHelpOverlayClaimed(): boolean {
	return claims > 0;
}
