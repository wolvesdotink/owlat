import type { JsonObject, JsonValue } from './json';
import type { PluginId } from './pluginId';

/**
 * Tier-2 signed synchronous hooks.
 *
 * A connected app (Tier 2) can serve HTTP endpoints that Owlat calls
 * synchronously at three decision points:
 *
 *   - `draft`  — offer a draft suggestion. Advisory; fails **open** (Owlat keeps
 *     its own draft on any failure). Output is untrusted text.
 *   - `gate`   — object to (hold) an auto-send. **Restrict-only**: a hook can
 *     only withhold approval, never grant it. Fails **closed toward caution**
 *     (a failure/timeout raises an objection and routes to human review).
 *   - `score`  — return an advisory numeric score + labels. Fails **open**
 *     (no score on failure). Output is untrusted text.
 *
 * This module is the wire contract shared by the host, connected-app SDKs, and
 * reference apps: the hook kinds, the signing scheme, the canonical
 * request/response strings that both sides HMAC, and the size/deadline/replay
 * bounds. It contains no crypto and no I/O — the host
 * (`@owlat/plugin-host`) owns signing/verification and the enforcement engine;
 * the Convex backend owns the SSRF-guarded transport.
 */

/** The three synchronous hook decision points. */
export type SyncHookKind = 'draft' | 'gate' | 'score';

export const SYNC_HOOK_KINDS: readonly SyncHookKind[] = Object.freeze([
	'draft',
	'gate',
	'score',
] as const);

/** Capability a connected app must be granted to serve any synchronous hook. */
export const PLUGIN_SYNC_HOOK_CAPABILITY = 'connected-app:hook' as const;

/**
 * Wire signature scheme identifier. Bumped only on a breaking change to the
 * canonical string or algorithm; it is part of the signed material so a signer
 * and verifier can never silently disagree on the scheme.
 */
export const SYNC_HOOK_SIGNATURE_SCHEME = 'OWLAT-HMAC-SHA256-v1' as const;

/** Default per-call wall-clock deadline. */
export const SYNC_HOOK_DEFAULT_DEADLINE_MS = 5_000;
/** Floor on a configured deadline; below this a call is not worth attempting. */
export const SYNC_HOOK_MIN_DEADLINE_MS = 250;
/** Hard ceiling on a configured deadline. */
export const SYNC_HOOK_MAX_DEADLINE_MS = 30_000;

/** Maximum bytes Owlat will send in a hook request body. */
export const SYNC_HOOK_MAX_REQUEST_BYTES = 128 * 1_024;
/** Maximum bytes Owlat will read from a hook response body. */
export const SYNC_HOOK_MAX_RESPONSE_BYTES = 64 * 1_024;

/**
 * How far a response timestamp may drift from Owlat's clock (either direction)
 * before the response is rejected as stale — the freshness half of replay
 * defense (the nonce cache is the other half).
 */
export const SYNC_HOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60_000;

/** Wire header names for the request Owlat sends. */
export const SYNC_HOOK_HEADERS = Object.freeze({
	scheme: 'x-owlat-hook-scheme',
	kind: 'x-owlat-hook-kind',
	hookId: 'x-owlat-hook-id',
	plugin: 'x-owlat-hook-plugin',
	organization: 'x-owlat-hook-org',
	timestamp: 'x-owlat-hook-timestamp',
	nonce: 'x-owlat-hook-nonce',
	signature: 'x-owlat-hook-signature',
	requestNonce: 'x-owlat-hook-request-nonce',
} as const);

/** Raised when contract-level validation fails (bad canonical input). */
export class SyncHookContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SyncHookContractError';
	}
}

/**
 * A resolved, ready-to-call hook. PP-22 (connected-app domain) builds these
 * from stored app records + endpoints + decrypted secrets and hands them to the
 * host engine; the engine treats the descriptor as opaque configuration.
 */
export interface SyncHookDescriptor {
	/** Stable identity of this hook endpoint (used in signing + circuit keying). */
	readonly hookId: string;
	readonly kind: SyncHookKind;
	/** The connected app that owns this hook. */
	readonly pluginId: PluginId;
	/** Tenant this hook is scoped to. */
	readonly organizationId: string;
	/** Absolute https(/http) endpoint URL. Validated for SSRF at call time. */
	readonly endpointUrl: string;
	/** Per-hook shared HMAC secret. Never leaves the backend. */
	readonly signingSecret: string;
	/** Wall-clock deadline for the call. Clamped to [MIN,MAX] by the engine. */
	readonly deadlineMs: number;
	/** When false the engine short-circuits to the declared fallback. */
	readonly enabled: boolean;
	/**
	 * For `gate` hooks: the operator-facing hold reason used when the hook fails
	 * closed. Ignored for `draft`/`score`. A default is supplied if omitted.
	 */
	readonly fallbackObjectionReason?: string;
}

/** The signed request envelope Owlat sends (before serialization to the wire). */
export interface SyncHookRequestEnvelope {
	readonly scheme: typeof SYNC_HOOK_SIGNATURE_SCHEME;
	readonly kind: SyncHookKind;
	readonly hookId: string;
	readonly pluginId: PluginId;
	readonly organizationId: string;
	/** Milliseconds since the Unix epoch. */
	readonly timestamp: number;
	/** Random, single-use per call. */
	readonly nonce: string;
	/** The exact JSON body string that will be transmitted and hashed. */
	readonly bodyHashHex: string;
}

/** The signed response envelope a connected app returns. */
export interface SyncHookResponseEnvelope {
	readonly scheme: string;
	readonly kind: SyncHookKind;
	/** Must echo the request nonce — binds the response to this exact request. */
	readonly requestNonce: string;
	readonly timestamp: number;
	/** Response-side single-use nonce, checked against a replay cache. */
	readonly nonce: string;
	/** Hash of the exact JSON response body the app transmitted. */
	readonly bodyHashHex: string;
}

/**
 * Deterministically serialize a JSON value: object keys sorted lexicographically
 * at every level, no insignificant whitespace, and non-finite numbers rejected.
 * Two structurally equal values always produce the same string, so a signer and
 * verifier that agree on the value agree on the bytes.
 */
export function canonicalizeJson(value: JsonValue): string {
	return serializeCanonical(value);
}

function serializeCanonical(value: JsonValue): string {
	if (value === null) return 'null';
	switch (typeof value) {
		case 'boolean':
			return value ? 'true' : 'false';
		case 'number':
			if (!Number.isFinite(value)) {
				throw new SyncHookContractError('Cannot canonicalize a non-finite number');
			}
			return JSON.stringify(value);
		case 'string':
			return JSON.stringify(value);
		case 'object': {
			if (Array.isArray(value)) {
				return `[${value.map(serializeCanonical).join(',')}]`;
			}
			const entries = value as { readonly [key: string]: JsonValue };
			const keys = Object.keys(entries).sort();
			const parts: string[] = [];
			for (const key of keys) {
				const child = entries[key];
				if (child === undefined) continue;
				parts.push(`${JSON.stringify(key)}:${serializeCanonical(child)}`);
			}
			return `{${parts.join(',')}}`;
		}
		default:
			throw new SyncHookContractError(`Cannot canonicalize a ${typeof value} value`);
	}
}

/**
 * The exact string both sides HMAC for a request. Every envelope field plus the
 * request body hash is bound in, newline-delimited, so no field can be tampered
 * with or reordered without invalidating the signature.
 */
export function buildCanonicalHookRequest(envelope: SyncHookRequestEnvelope): string {
	assertTimestamp(envelope.timestamp);
	assertNonEmpty(envelope.nonce, 'nonce');
	assertNonEmpty(envelope.hookId, 'hookId');
	assertHex(envelope.bodyHashHex, 'bodyHashHex');
	return [
		envelope.scheme,
		'request',
		envelope.kind,
		envelope.hookId,
		envelope.pluginId,
		envelope.organizationId,
		String(envelope.timestamp),
		envelope.nonce,
		envelope.bodyHashHex,
	].join('\n');
}

/** The exact string both sides HMAC for a response. Binds in the request nonce. */
export function buildCanonicalHookResponse(envelope: SyncHookResponseEnvelope): string {
	assertTimestamp(envelope.timestamp);
	assertNonEmpty(envelope.nonce, 'nonce');
	assertNonEmpty(envelope.requestNonce, 'requestNonce');
	assertHex(envelope.bodyHashHex, 'bodyHashHex');
	return [
		envelope.scheme,
		'response',
		envelope.kind,
		envelope.requestNonce,
		String(envelope.timestamp),
		envelope.nonce,
		envelope.bodyHashHex,
	].join('\n');
}

/** Clamp a configured deadline into the allowed range; reject non-integers. */
export function clampSyncHookDeadline(deadlineMs: number): number {
	if (!Number.isFinite(deadlineMs)) return SYNC_HOOK_DEFAULT_DEADLINE_MS;
	const rounded = Math.floor(deadlineMs);
	if (rounded < SYNC_HOOK_MIN_DEADLINE_MS) return SYNC_HOOK_MIN_DEADLINE_MS;
	if (rounded > SYNC_HOOK_MAX_DEADLINE_MS) return SYNC_HOOK_MAX_DEADLINE_MS;
	return rounded;
}

/** Byte length of a UTF-8 string, for request/response size enforcement. */
export function utf8ByteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** Build the JSON wire body for a request payload (exact bytes we sign + send). */
export function serializeHookRequestBody(payload: JsonObject): string {
	return JSON.stringify(payload);
}

function assertTimestamp(timestamp: number): void {
	if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
		throw new SyncHookContractError('Hook timestamp must be a positive integer (ms epoch)');
	}
}

function assertNonEmpty(value: string, field: string): void {
	if (typeof value !== 'string' || value.length === 0) {
		throw new SyncHookContractError(`Hook ${field} must be a non-empty string`);
	}
}

function assertHex(value: string, field: string): void {
	if (typeof value !== 'string' || !/^[0-9a-f]+$/.test(value)) {
		throw new SyncHookContractError(`Hook ${field} must be a lowercase hex string`);
	}
}
