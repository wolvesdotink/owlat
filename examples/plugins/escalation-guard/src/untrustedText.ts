/**
 * Clamp for the untrusted text this plugin handles: inbound mail bodies it
 * quotes back into a reason line, and model output returned by the host LLM
 * dispatch. Both must have control characters removed and be length-bounded
 * before the host is asked to store or render them.
 *
 * Each example plugin under `examples/plugins` is a standalone, copy-and-adapt
 * deliverable, so this helper is deliberately local rather than shared with the
 * other references — an author who copies this directory gets a working plugin
 * without an extra private package.
 */

// eslint-disable-next-line no-control-regex -- deliberately stripping C0/C7F control chars.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Replace control characters with spaces, collapse runs of whitespace, and clamp
 * to at most `max` code points. Slicing by code point (not UTF-16 unit) means a
 * multibyte character is never split across a surrogate boundary.
 */
export function clampUntrustedText(text: string, max: number): string {
	const sanitized = text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
	return [...sanitized].slice(0, max).join('').trim();
}
