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
