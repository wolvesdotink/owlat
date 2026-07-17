/**
 * Signed synchronous-hook wire contract and response validation (Tier 2).
 *
 * A connected app (PP-22) can serve three synchronous decision hooks that Owlat
 * calls at pipeline decision points:
 *   - `draft` — the app proposes a reply body (advisory; fails OPEN to the
 *     built-in default strategy).
 *   - `gate`  — the app may withhold auto-send (RESTRICT-ONLY; fails CLOSED to a
 *     caution objection). A gate can never approve, unblock, or force sending —
 *     the response schema is structurally incapable of it.
 *   - `score` — the app returns a bounded [0,1] score (advisory; fails OPEN to
 *     "no score").
 *
 * This module is PURE and V8-safe (no Node, no crypto, no I/O): it owns the
 * kinds, the protocol version, the header names, and — the security-critical
 * half — STRICT validation of the untrusted response an external service
 * returns. Everything a connected app sends back is untrusted: a response that
 * does not match the exact shape for its kind is rejected (→ `null`), and the
 * caller applies the kind's declared safe fallback. Text scrubbing/clamping of
 * the accepted values happens in the Node runtime that has the plugin binding;
 * this module never widens a decision and never trusts a field it did not
 * explicitly validate.
 */

import type { JsonObject, JsonValue } from '@owlat/plugin-kit';
import type { RestrictOnlyGateResult } from '@owlat/plugin-host';

/** The three synchronous hook kinds a connected app may serve. */
export const CONNECTED_APP_HOOK_KINDS = ['draft', 'gate', 'score'] as const;
export type ConnectedAppHookKind = (typeof CONNECTED_APP_HOOK_KINDS)[number];

const HOOK_KIND_SET: ReadonlySet<string> = new Set(CONNECTED_APP_HOOK_KINDS);

/** True iff `value` is a known hook-kind literal. */
export function isConnectedAppHookKind(value: string): value is ConnectedAppHookKind {
	return HOOK_KIND_SET.has(value);
}

/**
 * The protocol version. It is part of every signing string, so a receiver that
 * upgrades can distinguish versions and an old captured signature can never be
 * reinterpreted under a new scheme. Bumping is a breaking wire change.
 */
export const CONNECTED_APP_HOOK_PROTOCOL_VERSION = 'v1' as const;

/**
 * Canonical header names. Request and response reuse the signature/timestamp
 * headers; the two directions are domain-separated inside the SIGNING STRING
 * (`owlat.hook.request.v1` vs `owlat.hook.response.v1`), never by header name,
 * so a request signature can never be replayed as a response signature.
 */
export const CONNECTED_APP_HOOK_HEADERS = Object.freeze({
	/** Hook kind: `draft` | `gate` | `score`. */
	kind: 'x-owlat-hook',
	/** Protocol version, e.g. `v1`. */
	version: 'x-owlat-hook-version',
	/** The connected-app id, so the receiver selects the right shared secret. */
	appId: 'x-owlat-hook-app',
	/** Unix SECONDS. Signed; the receiver enforces its own freshness window. */
	timestamp: 'x-owlat-hook-timestamp',
	/** Per-request 128-bit nonce (base64url). Signed; binds the response. */
	nonce: 'x-owlat-hook-nonce',
	/** `v1=<hex hmac>` over the canonical string for this direction. */
	signature: 'x-owlat-hook-signature',
} as const);

/**
 * A hook request envelope. `payload` is Owlat-originated content (a bounded JSON
 * object composed by the caller); the response is what this module validates,
 * because the response is the untrusted, externally-controlled side.
 */
export interface ConnectedAppHookRequest {
	readonly hookKind: ConnectedAppHookKind;
	readonly protocolVersion: typeof CONNECTED_APP_HOOK_PROTOCOL_VERSION;
	readonly connectedAppId: string;
	readonly timestampSeconds: number;
	readonly nonce: string;
	readonly payload: JsonObject;
}

/** The accepted, validated result of a `draft` hook: a proposed reply body. */
export interface DraftHookResult {
	readonly hookKind: 'draft';
	readonly draft: string;
}

/** The accepted, validated result of a `gate` hook: a restrict-only verdict. */
export interface GateHookResult {
	readonly hookKind: 'gate';
	readonly gate: RestrictOnlyGateResult;
}

/** The accepted, validated result of a `score` hook: a bounded [0,1] score. */
export interface ScoreHookResult {
	readonly hookKind: 'score';
	readonly score: number;
	readonly reason?: string;
}

export type ConnectedAppHookResult = DraftHookResult | GateHookResult | ScoreHookResult;

/** A plain (prototype-clean) JSON object with only own, enumerable data keys. */
function isPlainJsonObject(value: JsonValue): value is JsonObject {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Read `key` as a string ONLY when it is an own, enumerable string value. */
function readOwnString(object: JsonObject, key: string): string | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
	return typeof descriptor.value === 'string' ? descriptor.value : undefined;
}

/** Read `key` as a finite number ONLY when it is an own, enumerable number. */
function readOwnFiniteNumber(object: JsonObject, key: string): number | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
	return typeof descriptor.value === 'number' && Number.isFinite(descriptor.value)
		? descriptor.value
		: undefined;
}

function ownKeyCount(object: JsonObject): number {
	return Reflect.ownKeys(object).length;
}

/**
 * Strictly validate a parsed response body for `draft`. Requires EXACTLY
 * `{ draft: <non-empty string> }`. Any extra key, wrong type, or empty string is
 * rejected. The accepted text is still untrusted — the caller scrubs/clamps it.
 */
function validateDraftResponse(body: JsonObject): DraftHookResult | null {
	if (ownKeyCount(body) !== 1) return null;
	const draft = readOwnString(body, 'draft');
	if (draft === undefined || draft.length === 0) return null;
	return { hookKind: 'draft', draft };
}

/**
 * Strictly validate a parsed response body for `gate`. The ONLY accepted shapes
 * are `{ outcome: 'no-objection' }` and `{ outcome: 'objection', reason: <str> }`.
 * There is deliberately no shape that can grant approval — a gate is
 * structurally restrict-only, so even a hostile app cannot force auto-send.
 */
function validateGateResponse(body: JsonObject): GateHookResult | null {
	const outcome = readOwnString(body, 'outcome');
	if (outcome === 'no-objection') {
		return ownKeyCount(body) === 1 ? { hookKind: 'gate', gate: { outcome: 'no-objection' } } : null;
	}
	if (outcome === 'objection') {
		if (ownKeyCount(body) !== 2) return null;
		const reason = readOwnString(body, 'reason');
		if (reason === undefined || reason.trim().length === 0) return null;
		return { hookKind: 'gate', gate: { outcome: 'objection', reason: reason.trim() } };
	}
	return null;
}

/**
 * Strictly validate a parsed response body for `score`. Requires a `score`
 * number in the closed range [0,1]; an optional non-empty `reason` string is the
 * only other permitted key. NaN/Infinity/out-of-range/extra keys are rejected.
 */
function validateScoreResponse(body: JsonObject): ScoreHookResult | null {
	const score = readOwnFiniteNumber(body, 'score');
	if (score === undefined || score < 0 || score > 1) return null;
	const keys = ownKeyCount(body);
	if (keys === 1) return { hookKind: 'score', score };
	if (keys !== 2) return null;
	const reason = readOwnString(body, 'reason');
	if (reason === undefined || reason.trim().length === 0) return null;
	return { hookKind: 'score', score, reason: reason.trim() };
}

/**
 * Parse + strictly validate an untrusted hook response body for `hookKind`.
 * Returns the typed result, or `null` when the body is not a plain JSON object
 * of the exact shape the kind requires — in which case the caller applies the
 * kind's declared safe fallback. Never throws.
 */
export function validateHookResponse(
	hookKind: ConnectedAppHookKind,
	body: JsonValue
): ConnectedAppHookResult | null {
	if (!isPlainJsonObject(body)) return null;
	switch (hookKind) {
		case 'draft':
			return validateDraftResponse(body);
		case 'gate':
			return validateGateResponse(body);
		case 'score':
			return validateScoreResponse(body);
	}
}
