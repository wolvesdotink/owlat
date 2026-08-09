/**
 * Shared HMAC + constant-time-comparison primitives used by Inbound adapters
 * and channel webhook handlers. Consolidates the three near-identical copies
 * of `constantTimeEqual` and the inline HMAC helpers that lived in the
 * per-provider webhook entry points and in webhooks/channels.ts.
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

/**
 * The parameterized HMAC: the ONE place in the backend that imports a signing
 * key and signs with it.
 *
 * The named helpers below are the fixed-algorithm spellings the per-provider
 * adapters read better with. Callers whose algorithm and encoding are DECLARED
 * rather than fixed — the provider feedback verifier registry and the plugin
 * inbound-signature contract, both of which choose sha256/sha1 × hex/base64 at
 * runtime — use this one directly instead of open-coding `importKey` + `sign`
 * again, which is what this module exists to stop.
 */
export async function hmacSignature(
	secret: string | Uint8Array,
	data: string,
	algorithm: 'sha256' | 'sha1',
	encoding: 'hex' | 'base64'
): Promise<string> {
	const key = await importHmacKey(secret, algorithm === 'sha256' ? 'SHA-256' : 'SHA-1');
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return encoding === 'hex' ? bytesToHex(sig) : bytesToBase64(sig);
}

export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
	return hmacSignature(secret, data, 'sha256', 'hex');
}

export async function hmacSha256Base64(secret: string | Uint8Array, data: string): Promise<string> {
	return hmacSignature(secret, data, 'sha256', 'base64');
}

export async function hmacSha1Base64(secret: string, data: string): Promise<string> {
	return hmacSignature(secret, data, 'sha1', 'base64');
}

/**
 * The freshness half of every `${timestamp}.${body}` HMAC scheme, stated once.
 *
 * Two verifiers enforce that scheme — the host's provider feedback verifier
 * registry (`webhooks/providerVerifierRegistry.ts`) and the plugin inbound
 * signature contract (`plugins/inboundSignature.ts`) — and they used to disagree
 * about what a timestamp IS. One accepted anything `Number()` could read
 * (`'1e3'`, `'0x10'`, `'12.0'`, negatives) against an unbounded declared
 * tolerance; the other required ASCII digits and clamped. Same scheme, two
 * rigours, and the weaker one is reached by DECLARED data. They now share these.
 */
const UNIX_SECONDS_PATTERN = /^\d{1,15}$/;

/**
 * ASCII digits only, and few enough of them to stay a safe integer. Anything a
 * numeric coercion would silently accept — exponent form, hex, a trailing
 * fraction, a sign — is not a timestamp a sender wrote.
 */
export function isUnixSecondsTimestamp(value: string | null | undefined): value is string {
	return typeof value === 'string' && UNIX_SECONDS_PATTERN.test(value);
}

/**
 * Bound a DECLARED tolerance before it is enforced.
 *
 * The declaration reaches a verifier from a manifest or a bundle — data the
 * validators bound, but a verifier must not depend on the artifact it is reading
 * having been validated by the version of the kit running now. Zero and
 * negatives would reject everything (a sender-visible outage from a typo), and
 * an unbounded value would widen the replay window without limit.
 */
export function clampToleranceSeconds(toleranceSeconds: number, maxSeconds: number): number {
	return Math.min(Math.max(Math.trunc(toleranceSeconds), 1), maxSeconds);
}

/**
 * Freshness in BOTH directions: a stale capture and a far-future timestamp,
 * which is how a captured request would otherwise be parked for later.
 *
 * `timestamp` must already have passed {@link isUnixSecondsTimestamp}. A
 * non-finite tolerance fails the comparison, so it rejects.
 */
export function isWithinTimestampTolerance(
	timestamp: string,
	toleranceSeconds: number,
	nowMs: number
): boolean {
	return Math.abs(nowMs / 1000 - Number(timestamp)) <= toleranceSeconds;
}
