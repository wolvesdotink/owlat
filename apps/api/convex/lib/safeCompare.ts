/**
 * Timing-safe equality check for secret strings.
 *
 * Used by every endpoint that authenticates via a shared instance secret
 * (e.g. `INSTANCE_SECRET`) — `/seed/admin`, `/seed/demo`, `/dev/reset`.
 *
 * The compare runs in constant time even when lengths differ, so a caller
 * cannot infer the expected secret length from response timing.
 */
export function safeCompare(a: string, b: string): boolean {
	if (a.length !== b.length) {
		// Run a same-length compare against `a` itself so the loop body still
		// executes — keeps the total work proportional to `a.length`, not the
		// (a, b) length pair.
		let result = 0;
		for (let i = 0; i < a.length; i++) {
			result |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i % b.length) | 0);
		}
		void result;
		return false;
	}
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
	}
	return result === 0;
}
