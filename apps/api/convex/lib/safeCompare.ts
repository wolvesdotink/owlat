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
	// Single-path fold — the length difference is folded into the SAME
	// accumulator as the byte comparison (matching `webhooks/security.ts`
	// `constantTimeEqual`), so there is no length-dependent branch a caller
	// could probe as a length oracle. `charCodeAt(i)` past the end of a string
	// is `NaN`; `NaN | 0` is `0`, so the longer side's trailing bytes XOR
	// against 0 and force a mismatch without an early return.
	let mismatch = a.length ^ b.length;
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) {
		mismatch |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
	}
	return mismatch === 0;
}
