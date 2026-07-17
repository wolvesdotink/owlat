import {
	buildCanonicalHookRequest,
	buildCanonicalHookResponse,
	clampSyncHookDeadline,
	serializeHookRequestBody,
	SYNC_HOOK_HEADERS,
	SYNC_HOOK_MAX_REQUEST_BYTES,
	SYNC_HOOK_MAX_RESPONSE_BYTES,
	SYNC_HOOK_SIGNATURE_SCHEME,
	SYNC_HOOK_TIMESTAMP_TOLERANCE_MS,
	utf8ByteLength,
	type JsonObject,
	type SyncHookDescriptor,
} from '@owlat/plugin-kit';
import { hashHookBody, signHookHmac, verifyHookHmac } from './signing';
import {
	DEFAULT_CIRCUIT_BREAKER_CONFIG,
	evaluateCircuit,
	recordCircuitFailure,
	recordCircuitSuccess,
	type CircuitBreakerConfig,
	type CircuitBreakerStore,
} from './circuitBreaker';
import {
	normalizeSyncHookResult,
	syncHookFallback,
	type HookTextScrubber,
	type SyncHookOutcomeReason,
	type SyncHookResult,
} from './result';

/** The request a {@link SyncHookTransport} must perform. */
export interface SyncHookTransportRequest {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
	readonly deadlineMs: number;
	readonly maxResponseBytes: number;
}

/** Why a transport-level call could not produce a usable response. */
export type SyncHookTransportFailureReason =
	| 'blocked'
	| 'timeout'
	| 'network'
	| 'too-large'
	| 'redirect';

export type SyncHookTransportOutcome =
	| {
			readonly ok: true;
			readonly status: number;
			readonly headers: Readonly<Record<string, string>>;
			readonly body: string;
	  }
	| { readonly ok: false; readonly reason: SyncHookTransportFailureReason; readonly error: string };

/**
 * Perform one signed HTTP call. The host owns signing and validation; the
 * transport owns only the wire: SSRF validation, redirect refusal, the deadline,
 * and the response size cap. Injected so the engine is unit-testable without a
 * network and the Node runtime owns the SSRF-guarded implementation.
 */
export type SyncHookTransport = (
	request: SyncHookTransportRequest
) => Promise<SyncHookTransportOutcome>;

/** Single-use response-nonce cache (defense-in-depth over timestamp freshness). */
export interface SeenNonceStore {
	/** Record the nonce; return true when it was fresh, false if already seen. */
	checkAndRecord(nonce: string, expiresAtMs: number): boolean;
}

export function createInMemorySeenNonceStore(now: () => number = Date.now): SeenNonceStore {
	const seen = new Map<string, number>();
	return {
		checkAndRecord(nonce, expiresAtMs) {
			const currentMs = now();
			for (const [key, expiry] of seen) {
				if (expiry <= currentMs) seen.delete(key);
			}
			if (seen.has(nonce)) return false;
			seen.set(nonce, expiresAtMs);
			return true;
		},
	};
}

export interface SyncHookInvokeDeps {
	readonly transport: SyncHookTransport;
	/** Current wall-clock time in ms. Injected for determinism. */
	readonly now: () => number;
	/** Fresh, unguessable per-call nonce. Injected for determinism. */
	readonly randomNonce: () => string;
	/** Scrubs prompt-injection markers from untrusted response text. */
	readonly scrubPromptInjection: HookTextScrubber;
	readonly seenNonces: SeenNonceStore;
	readonly circuit: CircuitBreakerStore;
	readonly circuitConfig?: CircuitBreakerConfig;
}

const TRANSPORT_FAILURE_REASONS: Readonly<
	Record<SyncHookTransportFailureReason, SyncHookOutcomeReason>
> = Object.freeze({
	blocked: 'transport-blocked',
	timeout: 'transport-timeout',
	network: 'transport-network',
	'too-large': 'transport-too-large',
	redirect: 'transport-redirect',
});

/**
 * Invoke a signed synchronous hook and return a validated, scrubbed result — or
 * the kind's declared safe fallback on any failure. Security-critical
 * invariants:
 *
 *   - Every outbound call is HMAC-signed over a canonical, tamper-evident string.
 *   - The response must carry a valid HMAC over its own canonical string, echo
 *     the request nonce, be timestamp-fresh, and use an unseen nonce; any miss
 *     falls back.
 *   - `gate` failures fall back to an **objection** (fail closed toward caution);
 *     a gate result can never approve or unblock a send.
 *   - All free text in the response is scrubbed + clamped before it is returned.
 */
export async function invokeSyncHook(
	descriptor: SyncHookDescriptor,
	payload: JsonObject,
	deps: SyncHookInvokeDeps
): Promise<SyncHookResult> {
	const fallback = (reason: SyncHookOutcomeReason): SyncHookResult =>
		syncHookFallback(descriptor.kind, reason, descriptor.fallbackObjectionReason);

	if (!descriptor.enabled) return fallback('disabled');

	const config = deps.circuitConfig ?? DEFAULT_CIRCUIT_BREAKER_CONFIG;
	const startMs = deps.now();
	const circuitBefore = deps.circuit.load(descriptor.hookId);
	if (!evaluateCircuit(circuitBefore, startMs, config).allowProbe) {
		return fallback('circuit-open');
	}

	const nonce = deps.randomNonce();
	if (typeof nonce !== 'string' || nonce.length === 0) return fallback('result-invalid');

	const body = serializeHookRequestBody(payload);
	if (utf8ByteLength(body) > SYNC_HOOK_MAX_REQUEST_BYTES) {
		// Our own oversize payload: don't attempt the call and don't penalize the
		// endpoint's circuit.
		return fallback('request-too-large');
	}

	const requestBodyHash = await hashHookBody(body);
	const canonicalRequest = buildCanonicalHookRequest({
		scheme: SYNC_HOOK_SIGNATURE_SCHEME,
		kind: descriptor.kind,
		hookId: descriptor.hookId,
		pluginId: descriptor.pluginId,
		organizationId: descriptor.organizationId,
		timestamp: startMs,
		nonce,
		bodyHashHex: requestBodyHash,
	});
	const signature = await signHookHmac(descriptor.signingSecret, canonicalRequest);

	const headers: Record<string, string> = {
		[SYNC_HOOK_HEADERS.scheme]: SYNC_HOOK_SIGNATURE_SCHEME,
		[SYNC_HOOK_HEADERS.kind]: descriptor.kind,
		[SYNC_HOOK_HEADERS.hookId]: descriptor.hookId,
		[SYNC_HOOK_HEADERS.plugin]: descriptor.pluginId,
		[SYNC_HOOK_HEADERS.organization]: descriptor.organizationId,
		[SYNC_HOOK_HEADERS.timestamp]: String(startMs),
		[SYNC_HOOK_HEADERS.nonce]: nonce,
		[SYNC_HOOK_HEADERS.signature]: signature,
	};

	let outcome: SyncHookTransportOutcome;
	try {
		outcome = await deps.transport({
			url: descriptor.endpointUrl,
			headers,
			body,
			deadlineMs: clampSyncHookDeadline(descriptor.deadlineMs),
			maxResponseBytes: SYNC_HOOK_MAX_RESPONSE_BYTES,
		});
	} catch {
		return failWithCircuit(descriptor, deps, config, fallback('transport-network'));
	}

	if (!outcome.ok) {
		return failWithCircuit(
			descriptor,
			deps,
			config,
			fallback(TRANSPORT_FAILURE_REASONS[outcome.reason])
		);
	}
	if (outcome.status !== 200) {
		return failWithCircuit(descriptor, deps, config, fallback('http-status'));
	}

	const verified = await verifyResponse(descriptor, nonce, outcome, deps);
	if (verified.reason !== 'ok') {
		return failWithCircuit(descriptor, deps, config, fallback(verified.reason));
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(outcome.body);
	} catch {
		return failWithCircuit(descriptor, deps, config, fallback('response-unparseable'));
	}

	const normalized = normalizeSyncHookResult(
		descriptor.kind,
		descriptor.pluginId,
		parsed,
		deps.scrubPromptInjection
	);
	if (normalized === null) {
		return failWithCircuit(descriptor, deps, config, fallback('result-invalid'));
	}

	deps.circuit.save(descriptor.hookId, recordCircuitSuccess());
	return normalized;
}

/** Verify the signed response envelope. Signature first, then replay checks. */
async function verifyResponse(
	descriptor: SyncHookDescriptor,
	requestNonce: string,
	outcome: Extract<SyncHookTransportOutcome, { ok: true }>,
	deps: SyncHookInvokeDeps
): Promise<{ readonly reason: SyncHookOutcomeReason }> {
	const headers = lowercaseHeaders(outcome.headers);
	const scheme = headers[SYNC_HOOK_HEADERS.scheme];
	const kind = headers[SYNC_HOOK_HEADERS.kind];
	const echoedNonce = headers[SYNC_HOOK_HEADERS.requestNonce];
	const responseNonce = headers[SYNC_HOOK_HEADERS.nonce];
	const timestampHeader = headers[SYNC_HOOK_HEADERS.timestamp];
	const signature = headers[SYNC_HOOK_HEADERS.signature];

	if (scheme !== SYNC_HOOK_SIGNATURE_SCHEME || kind !== descriptor.kind) {
		return { reason: 'response-mismatch' };
	}
	if (typeof echoedNonce !== 'string' || echoedNonce !== requestNonce) {
		return { reason: 'response-mismatch' };
	}
	if (typeof responseNonce !== 'string' || responseNonce.length === 0) {
		return { reason: 'response-mismatch' };
	}
	if (typeof signature !== 'string' || signature.length === 0) {
		return { reason: 'signature-missing' };
	}

	const timestamp = Number(timestampHeader);
	if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
		return { reason: 'response-mismatch' };
	}

	const responseBodyHash = await hashHookBody(outcome.body);
	const canonicalResponse = buildCanonicalHookResponse({
		scheme: SYNC_HOOK_SIGNATURE_SCHEME,
		kind: descriptor.kind,
		requestNonce,
		timestamp,
		nonce: responseNonce,
		bodyHashHex: responseBodyHash,
	});
	const signatureValid = await verifyHookHmac(
		descriptor.signingSecret,
		canonicalResponse,
		signature
	);
	if (!signatureValid) return { reason: 'signature-invalid' };

	// Only enforce freshness/replay on an authenticated response, so an attacker
	// cannot burn nonces with forged messages.
	const receiptMs = deps.now();
	if (Math.abs(receiptMs - timestamp) > SYNC_HOOK_TIMESTAMP_TOLERANCE_MS) {
		return { reason: 'timestamp-stale' };
	}
	const fresh = deps.seenNonces.checkAndRecord(
		responseNonce,
		receiptMs + SYNC_HOOK_TIMESTAMP_TOLERANCE_MS
	);
	if (!fresh) return { reason: 'nonce-replayed' };

	return { reason: 'ok' };
}

function failWithCircuit(
	descriptor: SyncHookDescriptor,
	deps: SyncHookInvokeDeps,
	config: CircuitBreakerConfig,
	result: SyncHookResult
): SyncHookResult {
	const record = deps.circuit.load(descriptor.hookId);
	deps.circuit.save(descriptor.hookId, recordCircuitFailure(record, deps.now(), config));
	return result;
}

function lowercaseHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		normalized[key.toLowerCase()] = value;
	}
	return normalized;
}
