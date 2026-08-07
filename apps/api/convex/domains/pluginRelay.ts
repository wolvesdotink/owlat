/**
 * A bundled plugin's two sending-domain identity calls, as scheduled work (the
 * seams plan's P3.2).
 *
 * `provision` mirrors `sesRelay.provision` / `mandrillRelay.provision`: a domain
 * whose PRIMARY provider is our own MTA also gets registered at the plugin relay
 * when the deployment's fallback configuration names it, so the migration arm has
 * a verified identity to send under without the operator connecting the domain
 * twice. `refreshIdentity` is the per-domain half of the re-check sweep, which is
 * what keeps a live proof inside `PLUGIN_RELAY_PROOF_MAX_AGE_MS`.
 *
 * ONE PAIR FOR EVERY BUNDLED PLUGIN, parameterised by the namespaced kind —
 * unlike the two core relays, which each ship their own. The provider
 * conversation is the only thing that varies, and it lives behind the module the
 * plugin ships.
 *
 * NOT `'use node'`. The identity module is imported by `domains/providers/`,
 * which the enqueue transaction reads, so the generated registry must stay
 * isolate-loadable; a `'use node'` action here would be a second import of the
 * same registry under the other runtime. Both calls a module makes are HTTP, and
 * `fetch` is available in the default action runtime.
 *
 * THE DEPLOYMENT-DEFAULT INSTANCE IS THE ONE THAT REGISTERS. A stored
 * `deliverabilityFallback.relayProviderType` names a KIND, never a
 * `kind#instance` id, so the relay path has always resolved the default
 * instance's credentials — and an identity registered under one account is not a
 * proof about another. Named-instance identities would need the route to carry
 * the instance first.
 */

import { v } from 'convex/values';
import { getPluginTransportEnv } from '../lib/env';
import { logError } from '../lib/runtimeLog';
import { parsePluginRelayResult, type PluginRelayCallOutcome } from './providers/plugin/state';
import { pluginSendTransportDomainIdentityFor } from '../plugins/sendTransportDomainIdentityCatalog';
import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import type { ActionCtx } from '../_generated/server';

/** What one scheduled identity call did, for the scheduler's own logs. */
type IdentityCallOutcome = 'checked' | 'auth_failed' | 'unavailable' | 'unregistered' | 'denied';

/**
 * Register a coexisting plugin relay identity without changing the primary
 * domain provider.
 *
 * Idempotent by contract: the module's `registerDomain` is asked to create or
 * confirm, and the mutation upserts. The backfill only reaches here when the row
 * is absent, or when the caller explicitly asked to re-provision.
 */
export const provision = internalAction({
	args: { kind: v.string(), domain: v.string() },
	handler: async (ctx, args): Promise<{ outcome: IdentityCallOutcome }> => ({
		outcome: await runIdentityCall(ctx, args.kind, args.domain, 'registerDomain'),
	}),
});

/**
 * Re-ask the provider about one domain and persist what it says.
 *
 * Keyed by domain NAME rather than by `domainId` because the sweep that schedules
 * it walks identity ROWS (which carry the name, not an id) — and because a relay
 * identity may outlive, or never have had, a `domains` row of its own kind.
 */
export const refreshIdentity = internalAction({
	args: { kind: v.string(), domain: v.string() },
	handler: async (ctx, args): Promise<{ outcome: IdentityCallOutcome }> => ({
		outcome: await runIdentityCall(ctx, args.kind, args.domain, 'checkDomain'),
	}),
});

/**
 * The whole call, once, for both directions — resolve, authorize, configure, ask,
 * persist, audit.
 *
 * EVERY GATE FAILS CLOSED AND WRITES NOTHING BUT A RETRY. An unregistered kind, a
 * revoked grant and a missing credential all stop before the module runs, and
 * none of them may look like a verdict: the row's `lastCheckedAt` is what the
 * relay proof's age is measured from, so a path that refreshed it without an
 * observation would keep a stale proof alive by failing.
 *
 * AND EVERY GATE THAT CAN BE REACHED FROM THE SWEEP WRITES THAT RETRY. A gate
 * that returned without moving `nextCheckDueAt` would leave the row permanently
 * due, and the hourly sweep would re-schedule it forever. The one exception is an
 * unregistered kind, which the sweep cannot reach: it has no dispatch arm in the
 * registry, so its rows are skipped before anything is scheduled.
 */
async function runIdentityCall(
	ctx: ActionCtx,
	kind: string,
	domain: string,
	call: 'registerDomain' | 'checkDomain'
): Promise<IdentityCallOutcome> {
	const identity = pluginSendTransportDomainIdentityFor(kind);
	// An unknown kind is not an error to raise: a stored route can name a
	// transport a later composition removed, and the sweep walks rows that outlive
	// their plugin. Nothing to ask, nothing to write.
	if (!identity) return 'unregistered';
	const { definition, module } = identity;

	// REAUTHORIZED PER CALL, not once at composition: an operator who disabled the
	// plugin or revoked its grant has stopped it acting, and a scheduled provider
	// call under this deployment's credential is exactly the kind of acting they
	// meant.
	const isAuthorized = await ctx.runMutation(
		internal.plugins.sendTransportDomainIdentityAuthorization.authorizeIdentityCall,
		{ pluginId: definition.pluginId, transportKind: kind }
	);
	if (!isAuthorized) {
		// THE RETRY STILL MOVES, or the sweep never stops: `nextCheckDueAt` is what
		// takes a row out of the due set, and a plugin left disabled is a steady
		// state rather than a moment. Nothing else is written — see the mutation.
		await ctx.runMutation(internal.domains.pluginRelayMutations.deferDeniedCheck, {
			kind,
			domain,
		});
		return 'denied';
	}

	const config = resolveIdentityConfig(definition.instanceEnvVars, definition.requiredEnvVars);
	if (!config) {
		// A credential this deployment does not have. Reported as the provider
		// rejecting it, which is the same operator action ("set the variable") and
		// the same write rule — the stored SPF/DKIM verdicts are not evidence about
		// a missing key and must not be overwritten by one.
		await recordFailure(ctx, kind, domain, true, 'required configuration variable is unset');
		await recordOutcome(ctx, definition.pluginId, kind, 'failed');
		return 'auth_failed';
	}

	const checkedAt = Date.now();
	const result = await callModule(module[call], kind, domain, config);
	if (result.outcome === 'ok') {
		await ctx.runMutation(internal.domains.pluginRelayMutations.recordCheck, {
			kind,
			domain,
			// Spread into mutable arrays for the validator's sake only: the parsed
			// observation is frozen, and Convex's `v.array` argument type is not
			// `readonly`.
			observation: {
				...result.observation,
				dkimSelectors: [...result.observation.dkimSelectors],
				spfMechanisms: [...result.observation.spfMechanisms],
			},
			checkedAt,
		});
		await recordOutcome(ctx, definition.pluginId, kind, 'completed');
		return 'checked';
	}
	await recordFailure(ctx, kind, domain, result.outcome === 'auth_failed', result.error);
	await recordOutcome(ctx, definition.pluginId, kind, 'failed');
	return result.outcome;
}

/**
 * Call the module and read what it returned.
 *
 * A THROW IS `unavailable`, never a verdict and never a condemned credential: the
 * host cannot distinguish a bug in third-party code from a provider outage, and
 * the conservative reading is the one that changes nothing but when to ask again.
 * The thrown value is deliberately not carried into the stored error — it is
 * untrusted text that may quote configuration.
 */
async function callModule(
	call: (domain: string, config: unknown) => Promise<unknown>,
	kind: string,
	domain: string,
	config: unknown
): Promise<PluginRelayCallOutcome> {
	try {
		return parsePluginRelayResult(await call(domain, config));
	} catch (error) {
		logError(`[pluginRelayIdentity] ${kind} identity call threw for ${domain}:`, error);
		return { outcome: 'unavailable', error: 'identity module threw' };
	}
}

/**
 * This transport's configuration for the deployment-default instance, or `null`
 * when a required variable is unset.
 *
 * Keyed by the BASE name, which is the whole contract the module reads against
 * (`PluginSendTransportConfig`). Only the transport's OWN declared variables are
 * resolved — the plugin's deployment-wide flag variables are the plugin's, and
 * the load-time guard in `plugins/sendTransportDomainIdentityCatalog.ts` has
 * already fenced every name here into the `PLUGIN_` namespace.
 */
function resolveIdentityConfig(
	instanceEnvVars: readonly string[],
	requiredEnvVars: readonly string[]
): { readonly instanceKey: null; readonly env: Readonly<Record<string, string>> } | null {
	const env: Record<string, string> = {};
	for (const name of instanceEnvVars) {
		const value = getPluginTransportEnv(name);
		if (value !== undefined) env[name] = value;
	}
	for (const name of requiredEnvVars) {
		if (env[name] === undefined) return null;
	}
	return Object.freeze({ instanceKey: null, env: Object.freeze(env) });
}

async function recordFailure(
	ctx: ActionCtx,
	kind: string,
	domain: string,
	isAuthFailure: boolean,
	error: string
): Promise<void> {
	await ctx.runMutation(internal.domains.pluginRelayMutations.recordCheckFailure, {
		kind,
		domain,
		isAuthFailure,
		error,
	});
}

async function recordOutcome(
	ctx: ActionCtx,
	pluginId: string,
	kind: string,
	outcome: 'completed' | 'failed'
): Promise<void> {
	await ctx.runMutation(internal.plugins.sendTransportDomainIdentityAuthorization.recordOutcome, {
		pluginId,
		transportKind: kind,
		outcome,
	});
}
