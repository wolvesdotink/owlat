/**
 * Web Crypto primitives shared by the two authentication surfaces this reference
 * app exposes: the Slack request signature (inbound button votes) and the Owlat
 * signed-hook protocol (inbound gate calls / outbound gate responses).
 *
 * Everything here uses `crypto.subtle` / `crypto.getRandomValues` only — the same
 * globals Owlat's `hookSignature` module uses — so the app runs unchanged on any
 * modern JS runtime (Node ≥ 20, Bun, Deno, workers) and every test is a plain
 * unit test with no injected fetch and no Node-only dependency.
 */

const encoder = new TextEncoder();

/** Lowercase-hex encode raw bytes. */
export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let hex = '';
	for (const byte of view) hex += byte.toString(16).padStart(2, '0');
	return hex;
}

/** SHA-256 of `bytes`, lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
	return bytesToHex(digest);
}

/** HMAC-SHA256 of the UTF-8 bytes of `data` under `secret`, lowercase hex. */
export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret) as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data) as BufferSource);
	return bytesToHex(signature);
}

/**
 * Length-independent constant-time string comparison. Unequal-length inputs
 * always return `false`, but only after folding every byte of both operands, so
 * a mismatched signature leaks no timing about how many leading characters
 * matched — the property a signature check must preserve to resist forgery.
 */
export function constantTimeEqual(a: string, b: string): boolean {
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);
	// Fold the length difference into the accumulator so equal-length-but-different
	// and different-length both take the same shape of work and never short-circuit.
	let mismatch = aBytes.length ^ bBytes.length;
	const length = Math.max(aBytes.length, bBytes.length);
	for (let index = 0; index < length; index += 1) {
		mismatch |= (aBytes[index] ?? 0) ^ (bBytes[index] ?? 0);
	}
	return mismatch === 0;
}
