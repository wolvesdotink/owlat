/**
 * When the desktop window may be shown.
 *
 * Windows are built hidden (src-tauri window::arm_reveal) so a launch never
 * shows an empty, on macOS and Windows 11 see-through, frame. The SPA splash
 * (app/spa-loading-template.html) is opaque and in the page before any script
 * runs, so the window can be shown as soon as the splash is on screen instead
 * of after the whole boot chain has mounted the app.
 */

/**
 * The longest the reveal waits for a frame. A hidden window may produce no
 * frames at all (WebKit and WebView2 can pause requestAnimationFrame for an
 * invisible view), and the splash is already in the DOM by then, so a short
 * timer stands in for the frame.
 */
export const SPLASH_PAINT_FALLBACK_MS = 100;

/**
 * Resolve once the splash has had a frame: the task after the next
 * requestAnimationFrame callback, or `SPLASH_PAINT_FALLBACK_MS` at the latest.
 */
export function afterSplashPaint(): Promise<void> {
	return new Promise<void>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		if (typeof requestAnimationFrame === 'function') {
			// rAF runs just before the frame; the timer lands after it is out.
			requestAnimationFrame(() => setTimeout(finish, 0));
		}
		setTimeout(finish, SPLASH_PAINT_FALLBACK_MS);
	});
}
