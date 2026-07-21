/**
 * The CLIENT half of Owlat's signed synchronous-hook protocol, written here
 * independently of the connected app's own verifier.
 *
 * The Tier-2 replay must prove that a request built from the PUBLISHED canonical
 * contract is accepted, and that anything else is refused. Reusing the app's
 * signing helpers would only prove it agrees with itself, so this module spells
 * the canonical strings out again, from the protocol description, using Web
 * Crypto directly:
 *
 *   request:  owlat.hook.request.v1 / kind / appId / timestamp / nonce / sha256(body)
 *   response: owlat.hook.response.v1 / kind / appId / requestNonce / timestamp / sha256(body)
 *
 * Verification is constant-time, like the host's (see `constantTimeEqual`).
 */

import { timingSafeEqual, webcrypto } from 'node:crypto';

const encoder = new TextEncoder();

/**
 * Compare two signature strings without leaking, through timing, how many
 * leading bytes matched — the same property `constantTimeEqual` gives Owlat's
 * own verifier (apps/api/convex/webhooks/security.ts, used by
 * connectedApps/hookSignature.ts). A length mismatch short-circuits: the length
 * of a signature is not a secret, and `timingSafeEqual` throws on unequal
 * buffers. This module is a tutorial source, so the comparison has to be the one
 * an author can safely copy into a real connected app.
 */
function constantTimeEqual(a: string, b: string): boolean {
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

export const HOOK_HEADERS = Object.freeze({
	kind: 'x-owlat-hook',
	version: 'x-owlat-hook-version',
	appId: 'x-owlat-hook-app',
	timestamp: 'x-owlat-hook-timestamp',
	nonce: 'x-owlat-hook-nonce',
	signature: 'x-owlat-hook-signature',
} as const);

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await webcrypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await webcrypto.subtle.sign('HMAC', key, encoder.encode(message));
	return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(message: string): Promise<string> {
	const digest = await webcrypto.subtle.digest('SHA-256', encoder.encode(message));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface HookRequestOptions {
	readonly secret: string;
	readonly appId: string;
	readonly hookKind?: string;
	readonly nonce: string;
	readonly timestampSeconds: number;
	readonly payload: unknown;
	/** Overrides used by the negative cases (forged signature, wrong version). */
	readonly signatureOverride?: string;
	readonly versionOverride?: string;
}

export interface SignedHookRequest {
	readonly rawBody: string;
	readonly headers: Readonly<Record<string, string>>;
}

/** Build the exact request Owlat would send for one hook call. */
export async function signHookRequest(options: HookRequestOptions): Promise<SignedHookRequest> {
	const hookKind = options.hookKind ?? 'gate';
	const rawBody = JSON.stringify({
		hookKind,
		protocolVersion: 'v1',
		connectedAppId: options.appId,
		timestampSeconds: options.timestampSeconds,
		nonce: options.nonce,
		payload: options.payload,
	});
	const signingString = [
		'owlat.hook.request.v1',
		hookKind,
		options.appId,
		String(options.timestampSeconds),
		options.nonce,
		await sha256Hex(rawBody),
	].join('\n');
	const signature =
		options.signatureOverride ?? `v1=${await hmacHex(options.secret, signingString)}`;
	return {
		rawBody,
		headers: {
			[HOOK_HEADERS.kind]: hookKind,
			[HOOK_HEADERS.version]: options.versionOverride ?? 'v1',
			[HOOK_HEADERS.appId]: options.appId,
			[HOOK_HEADERS.timestamp]: String(options.timestampSeconds),
			[HOOK_HEADERS.nonce]: options.nonce,
			[HOOK_HEADERS.signature]: signature,
		},
	};
}

export interface VerifyHookResponseOptions {
	readonly secret: string;
	readonly appId: string;
	readonly hookKind?: string;
	readonly requestNonce: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

/**
 * Verify the app's signed answer the way Owlat's hook client does: recompute the
 * canonical response signing string and compare in constant time, failing closed
 * on a missing header.
 */
export async function verifyHookResponse(options: VerifyHookResponseOptions): Promise<boolean> {
	const timestamp = options.headers[HOOK_HEADERS.timestamp];
	const signature = options.headers[HOOK_HEADERS.signature];
	if (!timestamp || !signature) return false;
	const signingString = [
		'owlat.hook.response.v1',
		options.hookKind ?? 'gate',
		options.appId,
		options.requestNonce,
		timestamp,
		await sha256Hex(options.body),
	].join('\n');
	return constantTimeEqual(signature, `v1=${await hmacHex(options.secret, signingString)}`);
}
