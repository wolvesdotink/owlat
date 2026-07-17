/**
 * Persistence surface for signed synchronous hooks (Tier 2). V8 runtime
 * (queries/mutations; no Node): the Node runtime layer (`hookRuntime.ts`) calls
 * these internal functions to resolve the tenant-scoped app + its circuit state
 * and to fold each call's outcome back into the breaker.
 *
 * Internal-only. There is no client-facing surface here — hooks are invoked by
 * the pipeline in a system context, not by an authenticated user. Tenant
 * isolation is enforced by matching `organizationId` on every load, so a hook
 * for org A can never read org B's app, secret, or breaker state.
 */

import { v } from 'convex/values';
import {
	parsePluginId,
	PLUGIN_AGENT_STEP_CAPABILITY,
	PLUGIN_AUTONOMY_GATE_CAPABILITY,
	PLUGIN_DRAFT_STRATEGY_CAPABILITY,
	type PluginCapability,
} from '@owlat/plugin-kit';
import { internalMutation, internalQuery } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import {
	CONNECTED_APP_HOOK_CIRCUIT_COOLDOWN_MS,
	CONNECTED_APP_HOOK_CIRCUIT_FAILURE_THRESHOLD,
} from '../lib/constants';
import { isBundledPluginCapabilityGranted } from '../plugins/authorization';
import {
	INITIAL_HOOK_CIRCUIT_STATE,
	recordHookFailure,
	recordHookSuccess,
	type HookCircuitState,
} from './hookCircuit';
import type { ConnectedAppHookKind } from './hookProtocol';
import type { ConnectedAppStatus } from './lifecycle';

/**
 * The operator capability each hook kind consumes. A connected-app hook is the
 * external half of a bundled-plugin contribution point, so the same capability
 * that gates the in-process contribution gates the hook: draft ↔ the draft
 * strategy, gate ↔ the autonomy send gate, score ↔ the agent (scoring) step.
 */
const HOOK_KIND_CAPABILITY: Readonly<Record<ConnectedAppHookKind, PluginCapability>> = {
	draft: PLUGIN_DRAFT_STRATEGY_CAPABILITY,
	gate: PLUGIN_AUTONOMY_GATE_CAPABILITY,
	score: PLUGIN_AGENT_STEP_CAPABILITY,
};

const hookKindValidator = v.union(v.literal('draft'), v.literal('gate'), v.literal('score'));

/** The sealed secret envelope columns the Node layer opens to sign a request. */
export interface HookSecretEnvelope {
	readonly secretCiphertext: string;
	readonly secretIv: string;
	readonly secretAuthTag: string;
	readonly secretEnvelopeVersion: number;
}

/**
 * Everything the Node runtime needs to attempt (or short-circuit) a hook,
 * modelled as a discriminated union on `found`: a missing / foreign-tenant app
 * carries only the neutral circuit state, while a resolved app carries the full
 * set of fields the runtime dereferences. Narrowing on `found` makes the
 * "present after the short-circuit" invariant tsc-enforced — no non-null
 * assertions, and no path can read a secret that was never loaded.
 */
export type HookExecutionContext =
	| { readonly found: false; readonly circuit: HookCircuitState }
	| LoadedHookContext;

/** The resolved-app branch of {@link HookExecutionContext}. */
export interface LoadedHookContext {
	readonly found: true;
	readonly status: ConnectedAppStatus;
	readonly pluginId: string;
	readonly endpointUrl: string;
	/**
	 * The restrict-only capability ceiling for THIS hook kind, recomputed on this
	 * load: `true` iff BOTH the app's own grant and the operator's plugin-level
	 * grant include the hook kind's capability. The runtime short-circuits to the
	 * declared fallback when this is `false`, so a mid-session disable, revoke, or
	 * grant removal fails closed — mirroring `authorizeConnectedAppStorage`.
	 */
	readonly capabilityGranted: boolean;
	readonly secret: HookSecretEnvelope;
	readonly circuit: HookCircuitState;
}

/**
 * Resolve the tenant-scoped app and its circuit state for one hook kind. Returns
 * `{ found: false }` (with the neutral circuit state) when the app is missing or
 * owned by another tenant — the runtime maps that to the `app_not_found`
 * fallback without leaking existence.
 */
export const _loadForHook = internalQuery({
	args: {
		organizationId: v.string(),
		connectedAppId: v.id('connectedApps'),
		hookKind: hookKindValidator,
	},
	handler: async (ctx, args): Promise<HookExecutionContext> => {
		const circuit = await loadCircuitState(ctx, args);
		const app = await ctx.db.get(args.connectedAppId);
		if (!app || app.organizationId !== args.organizationId) {
			return { found: false, circuit };
		}
		return {
			found: true,
			status: app.status,
			pluginId: app.pluginId,
			endpointUrl: app.endpointUrl,
			capabilityGranted: await isHookCapabilityGranted(ctx, app, args.hookKind),
			secret: {
				secretCiphertext: app.secretCiphertext,
				secretIv: app.secretIv,
				secretAuthTag: app.secretAuthTag,
				secretEnvelopeVersion: app.secretEnvelopeVersion,
			},
			circuit,
		};
	},
});

/**
 * The restrict-only ceiling for one hook kind, recomputed on every load: BOTH
 * the app's own grant AND the operator's plugin-level grant must include the
 * hook kind's capability. Either missing (or an unparseable bound plugin id)
 * denies, so the runtime fails closed. This composes the same two checks as
 * `authorizeConnectedAppStorage` — an app can only ever narrow, never widen,
 * what the operator allowed the bound plugin.
 */
async function isHookCapabilityGranted(
	ctx: QueryCtx,
	app: Doc<'connectedApps'>,
	hookKind: ConnectedAppHookKind
): Promise<boolean> {
	const capability = HOOK_KIND_CAPABILITY[hookKind];
	if (!app.grantedCapabilities.includes(capability)) return false;
	let pluginId;
	try {
		pluginId = parsePluginId(app.pluginId);
	} catch {
		return false;
	}
	return isBundledPluginCapabilityGranted(ctx, pluginId, capability);
}

/**
 * Fold a hook call's outcome into the (app, kind) breaker. A `success` fully
 * closes it; a `failure` increments the counter and opens the breaker once it
 * reaches the threshold. `nowMs` is the runtime's observed time so the recorded
 * open-until is consistent with the decision that produced it.
 */
export const _recordHookOutcome = internalMutation({
	args: {
		organizationId: v.string(),
		connectedAppId: v.id('connectedApps'),
		hookKind: hookKindValidator,
		outcome: v.union(v.literal('success'), v.literal('failure')),
		nowMs: v.number(),
	},
	handler: async (ctx, args): Promise<void> => {
		const existing = await ctx.db
			.query('connectedAppHookCircuits')
			.withIndex('by_app_and_kind', (index) =>
				index
					.eq('organizationId', args.organizationId)
					.eq('connectedAppId', args.connectedAppId)
					.eq('hookKind', args.hookKind)
			)
			.unique();

		const previous: HookCircuitState = existing
			? toCircuitState(existing.consecutiveFailures, existing.openedUntil)
			: INITIAL_HOOK_CIRCUIT_STATE;
		const next =
			args.outcome === 'success'
				? recordHookSuccess()
				: recordHookFailure(previous, args.nowMs, {
						failureThreshold: CONNECTED_APP_HOOK_CIRCUIT_FAILURE_THRESHOLD,
						cooldownMs: CONNECTED_APP_HOOK_CIRCUIT_COOLDOWN_MS,
					});

		const patch = {
			consecutiveFailures: next.consecutiveFailures,
			openedUntil: next.openedUntil,
			updatedAt: args.nowMs,
		};
		if (existing) {
			await ctx.db.patch(existing._id, patch);
			return;
		}
		await ctx.db.insert('connectedAppHookCircuits', {
			organizationId: args.organizationId,
			connectedAppId: args.connectedAppId,
			hookKind: args.hookKind,
			...patch,
		});
	},
});

async function loadCircuitState(
	ctx: QueryCtx,
	args: {
		organizationId: string;
		connectedAppId: Id<'connectedApps'>;
		hookKind: ConnectedAppHookKind;
	}
): Promise<HookCircuitState> {
	const row = await ctx.db
		.query('connectedAppHookCircuits')
		.withIndex('by_app_and_kind', (index) =>
			index
				.eq('organizationId', args.organizationId)
				.eq('connectedAppId', args.connectedAppId)
				.eq('hookKind', args.hookKind)
		)
		.unique();
	return row
		? toCircuitState(row.consecutiveFailures, row.openedUntil)
		: INITIAL_HOOK_CIRCUIT_STATE;
}

function toCircuitState(
	consecutiveFailures: number,
	openedUntil: number | undefined
): HookCircuitState {
	return openedUntil === undefined ? { consecutiveFailures } : { consecutiveFailures, openedUntil };
}
