'use node';

/**
 * Signed synchronous-hook TRANSPORT (Tier 2). NODE-RUNTIME ONLY: it fetches an
 * external URL through the SSRF guard and reads a bounded response stream.
 *
 * Given a resolved endpoint + plaintext shared secret + hook kind + payload,
 * this performs exactly one signed round trip and returns a structured outcome.
 * It layers every Tier-2 network invariant:
 *   - every outbound call goes through {@link fetchGuarded} (private/internal
 *     blocklist up front AND at connect time; redirects refused; https-only);
 *   - the request body is HMAC-signed with a fresh timestamp + nonce;
 *   - a hard deadline aborts a hanging endpoint;
 *   - the request and response bodies are byte-capped;
 *   - the response signature is verified CONSTANT-TIME and bound to our request
 *     nonce (response-side replay defense), with a freshness window;
 *   - the response JSON is STRICTLY validated for the hook kind.
 * It NEVER throws — every failure maps to a typed `error` outcome, and the
 * runtime layer turns that into the kind's declared safe fallback. It does NOT
 * scrub the accepted text (that needs the plugin binding); the runtime layer
 * that calls it always scrubs before any consumer sees the value.
 */

import {
	CONNECTED_APP_HOOK_MAX_REQUEST_BYTES,
	CONNECTED_APP_HOOK_MAX_RESPONSE_BYTES,
	CONNECTED_APP_HOOK_RESPONSE_TOLERANCE_MS,
	CONNECTED_APP_HOOK_TIMEOUT_MS,
} from '../lib/constants';
import {
	fetchGuarded,
	readCappedBytes,
	CappedReadOverflow,
	RedirectRefusedError,
	SsrfBlockedError,
} from '../lib/ssrfGuard';
import type { JsonObject, JsonValue } from '@owlat/plugin-kit';
import {
	CONNECTED_APP_HOOK_HEADERS,
	CONNECTED_APP_HOOK_PROTOCOL_VERSION,
	validateHookResponse,
	type ConnectedAppHookKind,
	type ConnectedAppHookRequest,
	type ConnectedAppHookResult,
} from './hookProtocol';
import { generateHookNonce, signHookRequest, verifyHookResponseSignature } from './hookSignature';

/** Why a hook call did not yield a valid result. Drives fallback + logging. */
export type HookFailureCode =
	| 'request_too_large'
	| 'blocked_ssrf'
	| 'redirect_refused'
	| 'timeout'
	| 'network_error'
	| 'bad_status'
	| 'response_too_large'
	| 'signature_missing'
	| 'signature_mismatch'
	| 'stale_response'
	| 'invalid_json'
	| 'invalid_response';

export type HookTransportOutcome =
	| { readonly status: 'ok'; readonly result: ConnectedAppHookResult }
	| { readonly status: 'error'; readonly code: HookFailureCode; readonly message: string };

export interface HookCallInput {
	readonly connectedAppId: string;
	readonly endpointUrl: string;
	/** Plaintext shared secret, opened from the sealed envelope by the caller. */
	readonly secret: string;
	readonly hookKind: ConnectedAppHookKind;
	readonly payload: JsonObject;
}

/** Injection seams so the round trip is deterministic under test. */
export interface HookCallDeps {
	readonly now: () => number;
	readonly nonce: () => string;
}

const DEFAULT_DEPS: HookCallDeps = Object.freeze({ now: Date.now, nonce: generateHookNonce });

function error(code: HookFailureCode, message: string): HookTransportOutcome {
	return { status: 'error', code, message };
}

/** Parse a header that must be a base-10 integer string; `null` if it is not. */
function parseIntegerHeader(value: string | null): number | null {
	if (value === null || !/^-?\d+$/.test(value.trim())) return null;
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Perform one signed hook call. See the module header for the guarantees. The
 * returned `ok` result is shape-validated but NOT yet text-scrubbed.
 */
export async function callConnectedAppHook(
	input: HookCallInput,
	deps: HookCallDeps = DEFAULT_DEPS
): Promise<HookTransportOutcome> {
	const nowMs = deps.now();
	const timestampSeconds = Math.floor(nowMs / 1000);
	const nonce = deps.nonce();

	const envelope: ConnectedAppHookRequest = {
		hookKind: input.hookKind,
		protocolVersion: CONNECTED_APP_HOOK_PROTOCOL_VERSION,
		connectedAppId: input.connectedAppId,
		timestampSeconds,
		nonce,
		payload: input.payload,
	};
	const bodyString = JSON.stringify(envelope);
	const bodyBytes = new TextEncoder().encode(bodyString);
	if (bodyBytes.length > CONNECTED_APP_HOOK_MAX_REQUEST_BYTES) {
		return error('request_too_large', 'Hook request body exceeds the size limit');
	}

	const signature = await signHookRequest(input.secret, {
		hookKind: input.hookKind,
		connectedAppId: input.connectedAppId,
		nonce,
		timestampSeconds,
		bodyBytes,
	});

	let response: Response;
	try {
		response = await fetchGuarded(input.endpointUrl, {
			method: 'POST',
			protocols: ['https:'],
			headers: {
				'content-type': 'application/json',
				[CONNECTED_APP_HOOK_HEADERS.kind]: input.hookKind,
				[CONNECTED_APP_HOOK_HEADERS.version]: CONNECTED_APP_HOOK_PROTOCOL_VERSION,
				[CONNECTED_APP_HOOK_HEADERS.appId]: input.connectedAppId,
				[CONNECTED_APP_HOOK_HEADERS.timestamp]: String(timestampSeconds),
				[CONNECTED_APP_HOOK_HEADERS.nonce]: nonce,
				[CONNECTED_APP_HOOK_HEADERS.signature]: signature,
			},
			body: bodyString,
			signal: AbortSignal.timeout(CONNECTED_APP_HOOK_TIMEOUT_MS),
		});
	} catch (cause) {
		return classifyFetchFailure(cause);
	}

	if (response.status < 200 || response.status >= 300) {
		await drain(response);
		return error('bad_status', `Hook endpoint returned HTTP ${response.status}`);
	}

	let responseBytes: Uint8Array | null;
	try {
		responseBytes = await readCappedBytes(response.body, CONNECTED_APP_HOOK_MAX_RESPONSE_BYTES);
	} catch (cause) {
		if (cause instanceof CappedReadOverflow) {
			return error('response_too_large', 'Hook response body exceeds the size limit');
		}
		return error('network_error', 'Failed to read the hook response body');
	}
	const responseBody = responseBytes ?? new Uint8Array(0);

	// Authenticate the response BEFORE trusting any of its bytes. The signed
	// timestamp is part of the signing string, so a forged timestamp fails here;
	// only an authenticated timestamp is then checked for freshness.
	const providedSignature = response.headers.get(CONNECTED_APP_HOOK_HEADERS.signature);
	if (providedSignature === null || providedSignature.length === 0) {
		return error('signature_missing', 'Hook response is missing its signature');
	}
	const responseTimestamp = parseIntegerHeader(
		response.headers.get(CONNECTED_APP_HOOK_HEADERS.timestamp)
	);
	if (responseTimestamp === null) {
		return error('signature_missing', 'Hook response is missing a valid timestamp');
	}
	const signatureValid = await verifyHookResponseSignature(
		input.secret,
		{
			hookKind: input.hookKind,
			connectedAppId: input.connectedAppId,
			nonce,
			timestampSeconds: responseTimestamp,
			bodyBytes: responseBody,
		},
		providedSignature
	);
	if (!signatureValid) {
		return error('signature_mismatch', 'Hook response signature did not verify');
	}
	if (Math.abs(deps.now() - responseTimestamp * 1000) > CONNECTED_APP_HOOK_RESPONSE_TOLERANCE_MS) {
		return error('stale_response', 'Hook response timestamp is outside the freshness window');
	}

	let parsed: JsonValue;
	try {
		parsed = JSON.parse(new TextDecoder().decode(responseBody)) as JsonValue;
	} catch {
		return error('invalid_json', 'Hook response body was not valid JSON');
	}

	const result = validateHookResponse(input.hookKind, parsed);
	if (result === null) {
		return error('invalid_response', `Hook response did not match the ${input.hookKind} schema`);
	}
	return { status: 'ok', result };
}

/** Drain and discard a response body under the cap; never throws. */
async function drain(response: Response): Promise<void> {
	try {
		await readCappedBytes(response.body, CONNECTED_APP_HOOK_MAX_RESPONSE_BYTES);
	} catch {
		// best-effort cleanup only
	}
}

/** Map a thrown fetch failure to a typed error outcome (matched by TYPE). */
function classifyFetchFailure(cause: unknown): HookTransportOutcome {
	if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
		return error('timeout', 'Hook call timed out');
	}
	if (cause instanceof SsrfBlockedError) {
		return error('blocked_ssrf', 'Hook endpoint resolves to a private/internal address');
	}
	if (cause instanceof RedirectRefusedError) {
		return error('redirect_refused', 'Hook endpoint attempted a redirect, which is refused');
	}
	return error('network_error', 'Hook call failed to reach the endpoint');
}
