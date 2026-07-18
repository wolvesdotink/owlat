/**
 * The server half of Owlat's signed synchronous-hook protocol (PP-24), as a
 * connected app must implement it. Owlat is the CLIENT (it signs and sends the
 * request); this app is the RECEIVER (it verifies the request and signs the
 * response). The canonical strings below reproduce Owlat's `hookSignature`
 * module byte-for-byte — that shared contract is the entire interop surface, and
 * the package's conformance test proves a request produced by Owlat's own signer
 * verifies here and a response signed here verifies on Owlat's side.
 *
 *   request signing string:            response signing string:
 *     owlat.hook.request.v1              owlat.hook.response.v1
 *     <hookKind>                         <hookKind>
 *     <connectedAppId>                   <connectedAppId>
 *     <timestampSeconds>                 <nonce>           ← echoes the request nonce
 *     <nonce>                            <timestampSeconds>← the response's own time
 *     <sha256Hex(bodyBytes)>             <sha256Hex(bodyBytes)>
 *
 * Verification FAILS CLOSED: a wrong protocol version, a foreign app id, a stale
 * timestamp, a replayed nonce, or any HMAC mismatch is rejected, and the caller
 * answers with the gate's safe fallback (hold). The request nonce is folded into
 * the RESPONSE signing string so Owlat can bind our answer to its exact call.
 */

import { constantTimeEqual, hmacSha256Hex, sha256Hex } from './crypto';

/** Header names — identical to Owlat's `CONNECTED_APP_HOOK_HEADERS`. */
export const OWLAT_HOOK_HEADERS = Object.freeze({
	kind: 'x-owlat-hook',
	version: 'x-owlat-hook-version',
	appId: 'x-owlat-hook-app',
	timestamp: 'x-owlat-hook-timestamp',
	nonce: 'x-owlat-hook-nonce',
	signature: 'x-owlat-hook-signature',
} as const);

export const OWLAT_HOOK_PROTOCOL_VERSION = 'v1' as const;

/** Reject request timestamps more than 5 min from now (replay window). */
export const OWLAT_HOOK_REQUEST_TOLERANCE_SECONDS = 60 * 5;

export const OWLAT_HOOK_KINDS = ['draft', 'gate', 'score'] as const;
export type OwlatHookKind = (typeof OWLAT_HOOK_KINDS)[number];

const HOOK_KIND_SET: ReadonlySet<string> = new Set(OWLAT_HOOK_KINDS);

/** Optional replay guard: return true the first time a nonce is seen, false after. */
export interface NonceGuard {
	claim(nonce: string, nowMs: number): boolean;
}

export interface VerifyHookRequestInput {
	readonly secret: string;
	/** This app's own connected-app id — a request for a different id is refused. */
	readonly expectedAppId: string;
	readonly headers: Readonly<Record<string, string | null | undefined>>;
	/** The exact request body bytes Owlat sent, decoded as UTF-8. */
	readonly rawBody: string;
	readonly nowMs: number;
	readonly toleranceSeconds?: number;
	readonly nonceGuard?: NonceGuard;
}

export type HookRequestFailure =
	| 'bad_version'
	| 'bad_kind'
	| 'foreign_app'
	| 'missing_timestamp'
	| 'stale_timestamp'
	| 'missing_nonce'
	| 'replayed_nonce'
	| 'missing_signature'
	| 'signature_mismatch';

export interface VerifiedHookRequest {
	readonly hookKind: OwlatHookKind;
	readonly connectedAppId: string;
	readonly nonce: string;
	readonly timestampSeconds: number;
}

export type VerifyHookRequestResult =
	| { readonly valid: true; readonly request: VerifiedHookRequest }
	| { readonly valid: false; readonly reason: HookRequestFailure };

const encoder = new TextEncoder();

function header(
	headers: Readonly<Record<string, string | null | undefined>>,
	name: string
): string | null {
	const value = headers[name] ?? headers[name.toLowerCase()];
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseTimestampSeconds(value: string | null): number | null {
	if (value === null || !/^-?\d+$/.test(value.trim())) return null;
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) ? parsed : null;
}

async function requestSigningString(
	hookKind: string,
	connectedAppId: string,
	timestampSeconds: number,
	nonce: string,
	bodyBytes: Uint8Array
): Promise<string> {
	return [
		`owlat.hook.request.${OWLAT_HOOK_PROTOCOL_VERSION}`,
		hookKind,
		connectedAppId,
		String(timestampSeconds),
		nonce,
		await sha256Hex(bodyBytes),
	].join('\n');
}

async function responseSigningString(
	hookKind: string,
	connectedAppId: string,
	nonce: string,
	timestampSeconds: number,
	bodyBytes: Uint8Array
): Promise<string> {
	return [
		`owlat.hook.response.${OWLAT_HOOK_PROTOCOL_VERSION}`,
		hookKind,
		connectedAppId,
		nonce,
		String(timestampSeconds),
		await sha256Hex(bodyBytes),
	].join('\n');
}

/**
 * Verify an inbound Owlat hook request end to end. On success returns the
 * authenticated (kind, app id, nonce, timestamp); on any problem returns a typed
 * failure and the caller holds. The signature is checked over the EXACT body
 * bytes, so a tampered payload never authenticates.
 */
export async function verifyOwlatHookRequest(
	input: VerifyHookRequestInput
): Promise<VerifyHookRequestResult> {
	if (header(input.headers, OWLAT_HOOK_HEADERS.version) !== OWLAT_HOOK_PROTOCOL_VERSION) {
		return { valid: false, reason: 'bad_version' };
	}
	const hookKind = header(input.headers, OWLAT_HOOK_HEADERS.kind);
	if (hookKind === null || !HOOK_KIND_SET.has(hookKind)) {
		return { valid: false, reason: 'bad_kind' };
	}
	const appId = header(input.headers, OWLAT_HOOK_HEADERS.appId);
	if (appId !== input.expectedAppId) {
		return { valid: false, reason: 'foreign_app' };
	}
	const timestampSeconds = parseTimestampSeconds(
		header(input.headers, OWLAT_HOOK_HEADERS.timestamp)
	);
	if (timestampSeconds === null) {
		return { valid: false, reason: 'missing_timestamp' };
	}
	const tolerance = input.toleranceSeconds ?? OWLAT_HOOK_REQUEST_TOLERANCE_SECONDS;
	if (Math.abs(Math.floor(input.nowMs / 1000) - timestampSeconds) > tolerance) {
		return { valid: false, reason: 'stale_timestamp' };
	}
	const nonce = header(input.headers, OWLAT_HOOK_HEADERS.nonce);
	if (nonce === null) {
		return { valid: false, reason: 'missing_nonce' };
	}
	const providedSignature = header(input.headers, OWLAT_HOOK_HEADERS.signature);
	if (providedSignature === null) {
		return { valid: false, reason: 'missing_signature' };
	}
	const bodyBytes = encoder.encode(input.rawBody);
	const expected = `${OWLAT_HOOK_PROTOCOL_VERSION}=${await hmacSha256Hex(
		input.secret,
		await requestSigningString(hookKind, appId, timestampSeconds, nonce, bodyBytes)
	)}`;
	if (!constantTimeEqual(providedSignature, expected)) {
		return { valid: false, reason: 'signature_mismatch' };
	}
	// Replay defense is applied ONLY after the request authenticates, so an
	// attacker cannot burn nonces with unsigned traffic.
	if (input.nonceGuard && !input.nonceGuard.claim(nonce, input.nowMs)) {
		return { valid: false, reason: 'replayed_nonce' };
	}
	return {
		valid: true,
		request: {
			hookKind: hookKind as OwlatHookKind,
			connectedAppId: appId,
			nonce,
			timestampSeconds,
		},
	};
}

export interface SignedHookResponse {
	readonly body: string;
	readonly headers: Readonly<Record<string, string>>;
}

/**
 * Sign an outbound response body so Owlat's `verifyHookResponseSignature`
 * accepts it: the signature binds the (request) `nonce`, this response's own
 * timestamp, and a SHA-256 of the exact body bytes. Returns the body plus the
 * headers to write.
 */
export async function signOwlatHookResponse(input: {
	readonly secret: string;
	readonly hookKind: OwlatHookKind;
	readonly connectedAppId: string;
	readonly requestNonce: string;
	readonly responseTimestampSeconds: number;
	readonly body: string;
}): Promise<SignedHookResponse> {
	const bodyBytes = encoder.encode(input.body);
	const signature = `${OWLAT_HOOK_PROTOCOL_VERSION}=${await hmacSha256Hex(
		input.secret,
		await responseSigningString(
			input.hookKind,
			input.connectedAppId,
			input.requestNonce,
			input.responseTimestampSeconds,
			bodyBytes
		)
	)}`;
	return {
		body: input.body,
		headers: Object.freeze({
			'content-type': 'application/json',
			[OWLAT_HOOK_HEADERS.kind]: input.hookKind,
			[OWLAT_HOOK_HEADERS.version]: OWLAT_HOOK_PROTOCOL_VERSION,
			[OWLAT_HOOK_HEADERS.appId]: input.connectedAppId,
			[OWLAT_HOOK_HEADERS.timestamp]: String(input.responseTimestampSeconds),
			[OWLAT_HOOK_HEADERS.signature]: signature,
		}),
	};
}

/** A bounded in-memory {@link NonceGuard}: a nonce is accepted once per window. */
export function createNonceGuard(windowSeconds = OWLAT_HOOK_REQUEST_TOLERANCE_SECONDS): NonceGuard {
	const seen = new Map<string, number>();
	return {
		claim(nonce, nowMs) {
			const windowMs = windowSeconds * 1000;
			for (const [key, seenAt] of seen) {
				if (nowMs - seenAt > windowMs) seen.delete(key);
			}
			if (seen.has(nonce)) return false;
			seen.set(nonce, nowMs);
			return true;
		},
	};
}
