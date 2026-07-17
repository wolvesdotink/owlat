/**
 * HMAC-SHA256 signing/verification and body hashing for signed synchronous
 * hooks. Web Crypto only, so this runs unchanged in the Convex V8 action runtime
 * and in tests. Verification compares in constant time to avoid leaking, byte by
 * byte, how much of a forged signature is correct.
 */

const encoder = new TextEncoder();

async function importHmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
}

function bytesToHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/** Lowercase-hex HMAC-SHA256 of `data` under `secret`. */
export async function signHookHmac(secret: string, data: string): Promise<string> {
	const key = await importHmacKey(secret);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
	return bytesToHex(signature);
}

/** Lowercase-hex SHA-256 of a UTF-8 string (used to bind the exact body bytes). */
export async function hashHookBody(body: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(body));
	return bytesToHex(digest);
}

/**
 * Constant-time string comparison. Length is folded into the accumulator so a
 * length mismatch can never short-circuit, and the loop always runs over the
 * longer input.
 */
export function constantTimeEqual(a: string, b: string): boolean {
	let mismatch = a.length ^ b.length;
	const length = Math.max(a.length, b.length);
	for (let index = 0; index < length; index++) {
		mismatch |= (a.charCodeAt(index) | 0) ^ (b.charCodeAt(index) | 0);
	}
	return mismatch === 0;
}

/**
 * Recompute the HMAC over `data` and compare it, in constant time, against the
 * signature the peer supplied. Returns false for a malformed (non-hex/empty)
 * candidate rather than throwing, so callers fail closed on any bad input.
 */
export async function verifyHookHmac(
	secret: string,
	data: string,
	candidateHex: string
): Promise<boolean> {
	if (typeof candidateHex !== 'string' || !/^[0-9a-f]+$/.test(candidateHex)) {
		return false;
	}
	const expected = await signHookHmac(secret, data);
	return constantTimeEqual(expected, candidateHex);
}
