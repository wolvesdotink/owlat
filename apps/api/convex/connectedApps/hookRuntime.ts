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
 *      app or an OPEN breaker — no network call, no secret opened;
 *   3. open the sealed shared secret (Node crypto) and run the signed,
 *      SSRF-guarded, deadline-bounded, size-capped transport call;
 *   4. SCRUB + CLAMP every app-returned string through the host untrusted-text
 *      policy (bound to the app's plugin) before it can reach any consumer;
 *   5. fold the outcome into the circuit breaker;
 *   6. return the app value, or the kind's declared safe fallback.
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
import type { HookExecutionContext, HookSecretEnvelope } from './hookStore';

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
		const hookKind = args.hookKind as ConnectedAppHookKind;
		const nowMs = Date.now();

		const context: HookExecutionContext = await ctx.runQuery(
			internal.connectedApps.hookStore._loadForHook,
			{ organizationId: args.organizationId, connectedAppId: args.connectedAppId, hookKind }
		);

		const shortCircuit = resolveShortCircuit(context, nowMs);
		if (shortCircuit) return hookFallback(hookKind, shortCircuit);

		let secret: string;
		let pluginId: ReturnType<typeof parsePluginId>;
		try {
			pluginId = parsePluginId(context.pluginId!);
			secret = openConnectedAppSecret(toEnvelope(context.secret!));
		} catch {
			// An unopenable secret or unparseable plugin id is an Owlat-side data
			// fault, not the app misbehaving — do not trip the breaker for it.
			return hookFallback(hookKind, 'secret_unavailable');
		}

		let transport: HookTransportOutcome;
		try {
			transport = await callConnectedAppHook({
				connectedAppId: args.connectedAppId,
				endpointUrl: context.endpointUrl!,
				secret,
				hookKind,
				payload: asPayload(args.payload),
			});
		} catch {
			await recordOutcome(ctx, args, hookKind, nowMs, 'failure');
			return hookFallback(hookKind, 'unexpected_error');
		}

		if (transport.status === 'error') {
			await recordOutcome(ctx, args, hookKind, nowMs, 'failure');
			return hookFallback(hookKind, transport.code);
		}

		const finalized = finalizeResult(pluginId, transport.result);
		if (finalized === null) {
			await recordOutcome(ctx, args, hookKind, nowMs, 'failure');
			return hookFallback(hookKind, 'output_rejected');
		}
		await recordOutcome(ctx, args, hookKind, nowMs, 'success');
		return finalized;
	},
});

/** The fallback reason to short-circuit with, or `null` to proceed to the call. */
function resolveShortCircuit(
	context: HookExecutionContext,
	nowMs: number
): HookUnavailableCode | null {
	if (!context.found) return 'app_not_found';
	if (context.status === 'revoked') return 'app_revoked';
	if (context.status !== 'enabled') return 'app_disabled';
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
