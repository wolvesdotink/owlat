/**
 * Canonical HMAC signing + constant-time verification for signed synchronous
 * hooks (Tier 2). PURE and V8-safe: it uses Web Crypto (`crypto.subtle`,
 * `crypto.getRandomValues`) only, so it runs in both the Node action runtime and
 * a plain unit test with no 'use node' dependency and no injected fetch.
 *
 * Both directions are HMAC-SHA256 over a NEWLINE-JOINED canonical string with a
 * fixed field order and a direction-specific domain tag:
 *
 *   request:                         response:
 *     owlat.hook.request.v1            owlat.hook.response.v1
 *     <hookKind>                       <hookKind>
 *     <connectedAppId>                 <connectedAppId>
 *     <timestampSeconds>               <nonce>            ← echoes the REQUEST nonce
 *     <nonce>                          <timestampSeconds>
 *     <sha256Hex(bodyBytes)>           <sha256Hex(bodyBytes)>
 *
 * The body is bound by its SHA-256, so a tampered body invalidates the
 * signature. The request nonce is folded into the RESPONSE signing string, so a
 * captured response can never be replayed against a different request (its nonce
 * won't match) — this is the response-side replay defense. The direction tag
 * means a request signature can never be reused as a response signature.
 * Verification is constant-time (see `constantTimeEqual`).
 */

import { constantTimeEqual, bytesToHex } from '../webhooks/security';
import type { ConnectedAppHookKind } from './hookProtocol';
import { CONNECTED_APP_HOOK_PROTOCOL_VERSION } from './hookProtocol';

/** The signature header value scheme, e.g. `v1=<hex>`. Version-pinned. */
const SIGNATURE_SCHEME = CONNECTED_APP_HOOK_PROTOCOL_VERSION;

/** Bytes of entropy in a per-request nonce (128 bits). */
const NONCE_ENTROPY_BYTES = 16;

/** Fields shared by both signing directions. */
export interface HookSignatureFields {
	readonly hookKind: ConnectedAppHookKind;
	readonly connectedAppId: string;
	readonly nonce: string;
	readonly timestampSeconds: number;
	/** The exact bytes of the JSON body being signed. */
	readonly bodyBytes: Uint8Array;
}

/** SHA-256 of `bytes`, lowercase hex. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
	return bytesToHex(digest);
}

/** HMAC-SHA256 of `data` under `secret`, lowercase hex. */
async function hmacHex(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return bytesToHex(signature);
}

/** A fresh, URL-safe 128-bit nonce. Uses the CSPRNG; no Node dependency. */
export function generateHookNonce(): string {
	const bytes = new Uint8Array(NONCE_ENTROPY_BYTES);
	crypto.getRandomValues(bytes);
	// base64url without padding — safe in a header value.
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function buildRequestSigningString(fields: HookSignatureFields): Promise<string> {
	return [
		`owlat.hook.request.${CONNECTED_APP_HOOK_PROTOCOL_VERSION}`,
		fields.hookKind,
		fields.connectedAppId,
		String(fields.timestampSeconds),
		fields.nonce,
		await sha256Hex(fields.bodyBytes),
	].join('\n');
}

async function buildResponseSigningString(fields: HookSignatureFields): Promise<string> {
	return [
		`owlat.hook.response.${CONNECTED_APP_HOOK_PROTOCOL_VERSION}`,
		fields.hookKind,
		fields.connectedAppId,
		fields.nonce,
		String(fields.timestampSeconds),
		await sha256Hex(fields.bodyBytes),
	].join('\n');
}

/** Sign the outbound request, returning the `v1=<hex>` header value. */
export async function signHookRequest(
	secret: string,
	fields: HookSignatureFields
): Promise<string> {
	const mac = await hmacHex(secret, await buildRequestSigningString(fields));
	return `${SIGNATURE_SCHEME}=${mac}`;
}

/**
 * Compute the expected `v1=<hex>` response signature. Exposed so a test (or a
 * reference app) can produce a valid counterpart; production verification goes
 * through {@link verifyHookResponseSignature}.
 */
export async function signHookResponse(
	secret: string,
	fields: HookSignatureFields
): Promise<string> {
	const mac = await hmacHex(secret, await buildResponseSigningString(fields));
	return `${SIGNATURE_SCHEME}=${mac}`;
}

/**
 * Constant-time-verify a response signature. Returns `true` ONLY when the header
 * is present, uses the pinned scheme, and its HMAC matches the recomputed one
 * over the exact response bytes + the REQUEST nonce. Any missing/malformed
 * header returns `false` (fail closed). The comparison is constant-time, so a
 * mismatched signature leaks no timing about how many leading bytes matched.
 */
export async function verifyHookResponseSignature(
	secret: string,
	fields: HookSignatureFields,
	providedSignature: string | null | undefined
): Promise<boolean> {
	if (typeof providedSignature !== 'string' || providedSignature.length === 0) return false;
	const expected = await signHookResponse(secret, fields);
	// Compare the whole `v1=<hex>` value in constant time; a wrong scheme prefix
	// simply mismatches like any other differing byte.
	return constantTimeEqual(providedSignature, expected);
}
