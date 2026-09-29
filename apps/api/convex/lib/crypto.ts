/**
 * The backend's constant-time comparison and HMAC, in one module.
 *
 * Signature checks, capability tokens and shared-secret headers in
 * `apps/api/convex` compare and sign through here rather than open-coding their
 * own `importKey` + `sign` + encoding or their own compare loop.
 * `scripts/check-crypto-primitives.sh` guards the common forms: an HMAC
 * `importKey` or a `timingSafeEqual(` outside the sanctioned modules fails
 * `bun run lint`. It is a pattern check, not a proof, so review new crypto code
 * against this module too.
 *
 * Web Crypto only, so the module runs in the V8 isolate and in `'use node'`
 * actions alike. `webhooks/security.ts` re-exports the compare and HMAC
 * helpers for the provider adapters that already import from it. Node services outside Convex
 * use `@owlat/shared/constantTimeEqual`, which has the same contract.
 */

import { bytesToBase64, bytesToBase64Url, bytesToHex } from './bytes';

/**
 * Whether `a` and `b` are the same string, without a length-dependent branch.
 *
 * The length difference is folded into the SAME accumulator as the per-unit
 * comparison and the loop always runs over the longer input, so an unequal
 * length costs what an unequal character costs. `charCodeAt(i)` past the end
 * of a string is `NaN`, and `NaN | 0` is `0`, so the longer side's trailing
 * units XOR against 0 without an early return. The running time still grows
 * with the longer input, so the length itself is not hidden. Two empty strings
 * are equal; use {@link secretMatches} to authenticate a caller.
 */
export function constantTimeEqual(a: string, b: string): boolean {
	let mismatch = a.length ^ b.length;
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) {
		mismatch |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
	}
	return mismatch === 0;
}

/**
 * Whether a presented shared secret (an `X-Instance-Secret` header, a proxy
 * secret, an upload token) matches the configured one. Fails closed: an empty or
 * missing value on EITHER side is a mismatch, so an unset secret can never be
 * satisfied by an empty header.
 */
export function secretMatches(
	presented: string | null | undefined,
	expected: string | null | undefined
): boolean {
	if (!presented || !expected) return false;
	return constantTimeEqual(presented, expected);
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
 * The parameterized HMAC: the one place in the backend that imports a signing
 * key and signs with it.
 *
 * The named helpers below are the fixed-algorithm spellings most callers read
 * better with. Callers whose algorithm and encoding are DECLARED rather than
 * fixed (the provider feedback verifier registry and the plugin inbound
 * signature contract choose sha256/sha1 × hex/base64 at runtime) use this one
 * directly.
 */
export async function hmacSignature(
	secret: string | Uint8Array,
	data: string,
	algorithm: 'sha256' | 'sha1',
	encoding: 'hex' | 'base64' | 'base64url'
): Promise<string> {
	const key = await importHmacKey(secret, algorithm === 'sha256' ? 'SHA-256' : 'SHA-1');
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	if (encoding === 'hex') return bytesToHex(sig);
	return encoding === 'base64url' ? bytesToBase64Url(sig) : bytesToBase64(sig);
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
