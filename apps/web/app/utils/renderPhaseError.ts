/**
 * Which errors a pane boundary contains.
 *
 * Only failures that leave part of the tree unable to render: a component's
 * setup or render throwing, an async component chunk failing to load, or the
 * patch of an update. Vue renders nothing in their place, so a fallback with
 * Retry is the only way back short of a reload.
 *
 * Everything else keeps going to the app's error handler (the toast and
 * diagnostics): a throwing click handler, watcher or lifecycle hook leaves the
 * component on screen and working, and replacing a composer with a fallback
 * because one button's handler failed would throw away what was typed.
 *
 * Vue names the phase in the `info` argument of `onErrorCaptured`: a readable
 * string in development, an error-reference URL ending in the numeric code in
 * production builds. Both forms are matched.
 */

/** Development-build phase names (Vue's ErrorTypeStrings). */
const RENDER_PHASE_NAMES = new Set([
	'setup function',
	'render function',
	'async component loader',
	'scheduler flush',
	'component update',
]);

/** Production-build codes (Vue's ErrorCodes) for the same phases. */
const RENDER_PHASE_CODES = new Set(['0', '1', '13', '14', '15']);

const PRODUCTION_INFO = /#runtime-(\w+)$/;

function isRenderPhase(info: string): boolean {
	if (RENDER_PHASE_NAMES.has(info)) return true;
	const code = PRODUCTION_INFO.exec(info)?.[1];
	return code !== undefined && RENDER_PHASE_CODES.has(code);
}

/**
 * A Nuxt error raised as fatal (or unhandled) is meant for the full-page error
 * screen that Nuxt's root component shows; a pane fallback must not swallow it.
 */
function isFatalNuxtError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null || !('__nuxt_error' in error)) return false;
	const { fatal, unhandled } = error as { fatal?: unknown; unhandled?: unknown };
	return fatal === true || unhandled === true;
}

/** True when a pane boundary should show its fallback for this error. */
export function isContainedRenderError(error: unknown, info: string): boolean {
	return isRenderPhase(info) && !isFatalNuxtError(error);
}
