/**
 * Shared HMAC + constant-time-comparison primitives used by Inbound adapters
 * and channel webhook handlers. Consolidates the three near-identical copies
 * of `constantTimeEqual` and the inline HMAC helpers that lived in
 * resendWebhook.ts, mtaWebhook.ts, and webhooks/channels.ts.
 *
 * Uses Web Crypto so this module is V8-runtime-safe — no 'use node'.
 */

/**
 * Fail-closed result returned by an adapter's `verifySignature` when the
 * signing secret is not configured — a 503 so the sender retries once the
 * env var is set, rather than a 401 that looks like a bad signature.
 */
export function missingSecretResult(varName: string): {
	ok: false;
	status: number;
	reason: string;
} {
	return {
		ok: false,
		status: 503,
		reason: `Webhook endpoint is not configured securely (missing ${varName})`,
	};
}

/**
 * Decode an `application/x-www-form-urlencoded` body into a plain param map.
 *
 * Repeated keys collapse to the last occurrence, which is what both providers
 * signing this shape (Twilio, Mandrill) do — neither sends a repeated key.
 */
export function parseFormParams(rawBody: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of new URLSearchParams(rawBody).entries()) {
		out[k] = v;
	}
	return out;
}

/**
 * The canonical signing string shared by Twilio and Mandrill: the exact request
 * URL, followed by every DECODED form param in alphabetical key order, key
 * immediately followed by value with no separator.
 *
 * One function rather than a copy per adapter — the two schemes are the same
 * construction under a different secret and a different header, and a
 * near-identical copy is precisely what this module exists to stop (see the
 * `constantTimeEqual` note above).
 *
 * https://www.twilio.com/docs/usage/security#validating-requests
 * https://mailchimp.com/developer/transactional/guides/track-respond-activity-webhooks/#authenticating-webhook-requests
 */
export function urlAndSortedParamsSigningBase(url: string, params: Record<string, string>): string {
	let base = url;
	for (const key of Object.keys(params).sort()) {
		base += key + params[key];
	}
	return base;
}

export function constantTimeEqual(a: string, b: string): boolean {
	// XOR lengths first — guarantees result ≠ 0 when lengths differ.
	let mismatch = a.length ^ b.length;
	// Iterate the longer string to prevent timing leaks.
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) {
		mismatch |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
	}
	return mismatch === 0;
}

export function bytesToHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export function bytesToBase64(buffer: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

async function importHmacKey(
	secret: string | Uint8Array,
	hash: 'SHA-1' | 'SHA-256'
): Promise<CryptoKey> {
	const raw = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
	return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash }, false, [
		'sign',
	]);
}

export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
	const key = await importHmacKey(secret, 'SHA-256');
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return bytesToHex(sig);
}

export async function hmacSha256Base64(secret: string | Uint8Array, data: string): Promise<string> {
	const key = await importHmacKey(secret, 'SHA-256');
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return bytesToBase64(sig);
}

export async function hmacSha1Base64(secret: string, data: string): Promise<string> {
	const key = await importHmacKey(secret, 'SHA-1');
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return bytesToBase64(sig);
}
