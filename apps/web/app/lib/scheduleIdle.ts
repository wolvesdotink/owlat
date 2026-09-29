/**
 * Run background work when the main thread has nothing better to do.
 *
 * Uses `requestIdleCallback` with a deadline, so the work still happens on a
 * busy page. WebKit has no `requestIdleCallback` (Safari, and the macOS desktop
 * webview), so there it falls back to a short timer: the work still leaves the
 * current task, it just cannot wait for a quiet frame.
 */

/** Delay of the timer fallback where `requestIdleCallback` is missing. */
export const IDLE_FALLBACK_DELAY_MS = 200;

type IdleWindow = {
	requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
};

/** Schedule `cb` for idle time, running it after `timeoutMs` at the latest. */
export function scheduleIdle(cb: () => void, timeoutMs: number): void {
	const ric =
		typeof window === 'undefined' ? undefined : (window as IdleWindow).requestIdleCallback;
	if (typeof ric === 'function') ric(cb, { timeout: timeoutMs });
	else setTimeout(cb, Math.min(IDLE_FALLBACK_DELAY_MS, timeoutMs));
}
