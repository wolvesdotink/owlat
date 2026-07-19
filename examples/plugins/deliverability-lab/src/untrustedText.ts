/**
 * Shared sanitizer for the two streams of UNTRUSTED text this plugin logs or
 * surfaces: a seedbox vendor's `reason` string (`remoteScore.ts`) and the model's
 * deliverability tip (`cron.ts`). Both must strip C0/C7F control characters and be
 * bounded to a maximum length before they are trusted enough to log, so the one
 * clamp lives here rather than being re-implemented (and silently drifting) per
 * call site.
 */

// eslint-disable-next-line no-control-regex -- deliberately stripping C0/C7F control chars.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Strip control characters (to spaces) and clamp `text` to at most `max` code
 * points. Trims before slicing so leading/trailing control-char whitespace never
 * eats into the budget, and again after so a boundary space is never returned.
 * Slices by CODE POINTS so a multibyte character is never split mid-surrogate.
 */
export function clampUntrustedText(text: string, max: number): string {
	const sanitized = text.replace(CONTROL_CHARS, ' ').trim();
	return [...sanitized].slice(0, max).join('').trim();
}
