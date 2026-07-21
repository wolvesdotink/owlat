'use node';

/**
 * Signed synchronous-hook RUNTIME (Tier 2) — the Node action that orchestrates
 * one draft/gate/score hook end to end and is the ONLY surface the pipeline
 * calls. It composes the pure protocol/signature/circuit modules with the
 * persistence layer and the transport, and it is where the security envelope
 * lives:
 *
 *   1. resolve the tenant-scoped app + circuit state (internal query);
 *   2. short-circuit to the declared fallback for a missing / disabled / revoked
 *      app, a hook kind the operator has not granted this app (restrict-only
 *      capability ceiling), or an OPEN breaker — no network call, no secret
 *      opened;
 *   3. open the sealed shared secret (Node crypto) and run the signed,
 *      SSRF-guarded, deadline-bounded, size-capped transport call;
 *   4. SCRUB + CLAMP every app-returned string through the host untrusted-text
 *      policy (bound to the app's plugin) before it can reach any consumer;
 *   5. fold the outcome into the circuit breaker;
 *   6. record a redacted, tenant-scoped delivery-log row (PP-25) — the kind,
 *      whether a call was attempted, which side won, the fallback reason, and the
 *      network duration, and NOTHING sensitive;
 *   7. return the app value, or the kind's declared safe fallback.
 *
 * The fail direction is fixed by `hookOutcome`: gate fails CLOSED to caution,
 * draft/score fail OPEN. A hook can only ever add work or caution.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { parsePluginId } from '@owlat/plugin-kit';
import type { JsonObject } from '@owlat/plugin-kit';
import { applyPluginUntrustedTextPolicy } from '@owlat/plugin-host';
import { scrubForInjection } from '../assistant/prompt';
import {
	CONNECTED_APP_HOOK_MAX_DRAFT_CODE_POINTS,
	CONNECTED_APP_HOOK_MAX_REASON_CODE_POINTS,
} from '../lib/constants';
import { openConnectedAppSecret } from './secretBox';
import { callConnectedAppHook, type HookTransportOutcome } from './hookClient';
import {
	hookFallback,
	type ConnectedAppHookOutcome,
	type GateHookOutcome,
	type HookUnavailableCode,
} from './hookOutcome';
import type { ConnectedAppHookKind, ConnectedAppHookResult } from './hookProtocol';
import { isHookCircuitOpen } from './hookCircuit';
import type { HookExecutionContext, HookSecretEnvelope, LoadedHookContext } from './hookStore';

/**
 * How one hook resolved, for the circuit breaker AND the delivery log. `attempted`
 * is true iff an outbound network round trip was made; `circuit` is the outcome to
 * fold into the breaker, or `null` when the resolution never touched the endpoint
 * (a short-circuit or an Owlat-side data fault must not trip it); `durationMs` is
 * the round-trip time when a call was made.
 */
interface HookResolution {
	readonly outcome: ConnectedAppHookOutcome;
	readonly attempted: boolean;
	readonly circuit: 'success' | 'failure' | null;
	readonly durationMs?: number;
}

function shortCircuited(outcome: ConnectedAppHookOutcome): HookResolution {
	return { outcome, attempted: false, circuit: null };
}

function attempted(
	outcome: ConnectedAppHookOutcome,
	circuit: 'success' | 'failure',
	durationMs: number
): HookResolution {
	return { outcome, attempted: true, circuit, durationMs };
}

/** The fixed fallback reason a fallback outcome carries; `undefined` for app values. */
function deliveryFailureCode(outcome: ConnectedAppHookOutcome): HookUnavailableCode | undefined {
	return outcome.source === 'fallback' ? outcome.failureCode : undefined;
}

/** Coerce the internal payload arg to a plain JSON object (never trusts prototype). */
function asPayload(value: unknown): JsonObject {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null ? (value as JsonObject) : {};
}

/**
 * Invoke a connected app's signed synchronous hook. Internal-only: the pipeline
 * calls it in a system context. Always resolves to a {@link ConnectedAppHookOutcome}
 * — it never throws and never returns anything that could approve or force a send.
 */
export const invokeHook = internalAction({
	args: {
		organizationId: v.string(),
		connectedAppId: v.id('connectedApps'),
		hookKind: v.union(v.literal('draft'), v.literal('gate'), v.literal('score')),
		payload: v.any(),
	},
	handler: async (ctx, args): Promise<ConnectedAppHookOutcome> => {
		const hookKind = args.hookKind;
		const nowMs = Date.now();

		const context: HookExecutionContext = await ctx.runQuery(
			internal.connectedApps.hookStore._loadForHook,
			{ organizationId: args.organizationId, connectedAppId: args.connectedAppId, hookKind }
		);

		const resolution = await resolveHook(
			context,
			hookKind,
			args.connectedAppId,
			asPayload(args.payload)
		);

		// Fold a network outcome into the breaker (never a short-circuit / data fault).
		if (resolution.circuit) {
			await recordOutcome(ctx, args, hookKind, nowMs, resolution.circuit);
		}
		// Record the redacted delivery log. Best-effort: a logging fault must never
		// change the hook's outcome, so it is swallowed inside recordDelivery.
		await recordDelivery(ctx, args, hookKind, nowMs, context, resolution);
		return resolution.outcome;
	},
});

/**
 * Run one hook to a {@link HookResolution} without touching persistence. Mirrors
 * the security envelope: missing / disabled / revoked / ungranted / open-breaker
 * short-circuits to the declared fallback with no call; an Owlat-side secret
 * fault falls back WITHOUT tripping the breaker; a network error, a rejected
 * output, or a thrown transport folds a failure into the breaker; a validated,
 * scrubbed app value folds a success.
 */
async function resolveHook(
	context: HookExecutionContext,
	hookKind: ConnectedAppHookKind,
	connectedAppId: Id<'connectedApps'>,
	payload: JsonObject
): Promise<HookResolution> {
	if (!context.found) return shortCircuited(hookFallback(hookKind, 'app_not_found'));
	const shortCircuit = resolveShortCircuit(context, Date.now());
	if (shortCircuit) return shortCircuited(hookFallback(hookKind, shortCircuit));

	let secret: string;
	let pluginId: ReturnType<typeof parsePluginId>;
	try {
		pluginId = parsePluginId(context.pluginId);
		secret = openConnectedAppSecret(toEnvelope(context.secret));
	} catch {
		// An unopenable secret or unparseable plugin id is an Owlat-side data
		// fault, not the app misbehaving — do not trip the breaker for it.
		return shortCircuited(hookFallback(hookKind, 'secret_unavailable'));
	}

	const callStartedAt = Date.now();
	let transport: HookTransportOutcome;
	try {
		transport = await callConnectedAppHook({
			connectedAppId,
			endpointUrl: context.endpointUrl,
			secret,
			hookKind,
			payload,
		});
	} catch {
		return attempted(
			hookFallback(hookKind, 'unexpected_error'),
			'failure',
			Date.now() - callStartedAt
		);
	}
	const durationMs = Date.now() - callStartedAt;

	if (transport.status === 'error') {
		return attempted(hookFallback(hookKind, transport.code), 'failure', durationMs);
	}
	const finalized = finalizeResult(pluginId, transport.result);
	if (finalized === null) {
		return attempted(hookFallback(hookKind, 'output_rejected'), 'failure', durationMs);
	}
	return attempted(finalized, 'success', durationMs);
}

/**
 * Persist the redacted delivery-log row for one resolution. Best-effort — a
 * failed write is swallowed so it can never change the hook's outcome — and
 * carries only non-sensitive metadata (no payload, app text, secret, or
 * signature). `pluginId` is included only when the app resolved.
 */
async function recordDelivery(
	ctx: ActionCtx,
	args: { organizationId: string; connectedAppId: Id<'connectedApps'> },
	hookKind: ConnectedAppHookKind,
	nowMs: number,
	context: HookExecutionContext,
	resolution: HookResolution
): Promise<void> {
	const failureCode = deliveryFailureCode(resolution.outcome);
	await ctx
		.runMutation(internal.connectedApps.hookDeliveryLogStore._recordHookDelivery, {
			organizationId: args.organizationId,
			connectedAppId: args.connectedAppId,
			...(context.found ? { pluginId: context.pluginId } : {}),
			hookKind,
			isAttempted: resolution.attempted,
			source: resolution.outcome.source,
			...(failureCode === undefined ? {} : { failureCode }),
			...(resolution.durationMs === undefined ? {} : { durationMs: resolution.durationMs }),
			attemptedAt: nowMs,
		})
		.catch(() => undefined);
}

/**
 * The fallback reason to short-circuit a RESOLVED app with, or `null` to proceed
 * to the call. The missing / foreign-tenant case is handled by the caller's
 * `found` narrowing, so this only weighs the loaded app's lifecycle and breaker.
 */
function resolveShortCircuit(
	context: LoadedHookContext,
	nowMs: number
): HookUnavailableCode | null {
	if (context.status === 'revoked') return 'app_revoked';
	if (context.status !== 'enabled') return 'app_disabled';
	// Restrict-only ceiling: the operator must have granted this app AND its bound
	// plugin the hook kind's capability. A missing grant fails closed before any
	// secret is opened or endpoint contacted — no network call, no breaker trip.
	if (!context.capabilityGranted) return 'capability_denied';
	if (isHookCircuitOpen(context.circuit, nowMs)) return 'circuit_open';
	return null;
}

function toEnvelope(secret: HookSecretEnvelope) {
	return {
		ciphertext: secret.secretCiphertext,
		iv: secret.secretIv,
		authTag: secret.secretAuthTag,
		version: secret.secretEnvelopeVersion,
	};
}

async function recordOutcome(
	ctx: ActionCtx,
	args: { organizationId: string; connectedAppId: Id<'connectedApps'> },
	hookKind: ConnectedAppHookKind,
	nowMs: number,
	outcome: 'success' | 'failure'
): Promise<void> {
	await ctx
		.runMutation(internal.connectedApps.hookStore._recordHookOutcome, {
			organizationId: args.organizationId,
			connectedAppId: args.connectedAppId,
			hookKind,
			outcome,
			nowMs,
		})
		.catch(() => undefined);
}

/**
 * Scrub + clamp the app-returned text and build the consumer-facing app outcome.
 * Returns `null` when the (untrusted) output is rejected — an empty/hostile draft
 * or gate reason — so the caller applies the declared fallback. A gate outcome is
 * ALWAYS a restrict-only verdict; nothing here can widen it.
 */
function finalizeResult(
	pluginId: ReturnType<typeof parsePluginId>,
	result: ConnectedAppHookResult
): ConnectedAppHookOutcome | null {
	switch (result.hookKind) {
		case 'draft': {
			const draft = scrub(pluginId, result.draft, CONNECTED_APP_HOOK_MAX_DRAFT_CODE_POINTS);
			if (draft === null) return null;
			return { hookKind: 'draft', source: 'app', draft };
		}
		case 'gate':
			return finalizeGate(pluginId, result.gate);
		case 'score': {
			if (result.reason === undefined) {
				return { hookKind: 'score', source: 'app', score: result.score };
			}
			const reason = scrub(pluginId, result.reason, CONNECTED_APP_HOOK_MAX_REASON_CODE_POINTS);
			// The score is the value; a reason that scrubs away is simply dropped.
			return reason === null
				? { hookKind: 'score', source: 'app', score: result.score }
				: { hookKind: 'score', source: 'app', score: result.score, reason };
		}
	}
}

function finalizeGate(
	pluginId: ReturnType<typeof parsePluginId>,
	gate: { outcome: 'no-objection' } | { outcome: 'objection'; reason: string }
): GateHookOutcome | null {
	if (gate.outcome === 'no-objection') {
		return { hookKind: 'gate', source: 'app', gate: { outcome: 'no-objection' } };
	}
	const reason = scrub(pluginId, gate.reason, CONNECTED_APP_HOOK_MAX_REASON_CODE_POINTS);
	if (reason === null) return null;
	return { hookKind: 'gate', source: 'app', gate: { outcome: 'objection', reason } };
}

/** Apply the host untrusted-text policy; `null` when the text rejects or empties. */
function scrub(
	pluginId: ReturnType<typeof parsePluginId>,
	text: string,
	maximumCodePoints: number
): string | null {
	let cleaned: string;
	try {
		cleaned = applyPluginUntrustedTextPolicy(pluginId, text, {
			maximumCodePoints,
			scrubPromptInjection: scrubForInjection,
		});
	} catch {
		return null;
	}
	const trimmed = cleaned.trim();
	return trimmed.length === 0 ? null : trimmed;
}
