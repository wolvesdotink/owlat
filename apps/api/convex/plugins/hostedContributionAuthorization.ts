import { parsePluginId, type PluginCapability, type PluginId } from '@owlat/plugin-kit';
import type { MutationCtx } from '../_generated/server';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import type { HostedPluginAuditReasonCode, HostedPluginOperation } from './audit';
import { recordHostedPluginAudit } from './audit';
import {
	authorizeSystemBundledPlugin,
	SYSTEM_PLUGIN_ACTOR_ID,
	type HostedPluginActorScope,
} from './authorization';

/**
 * Shared runtime-authorization logic for a plugin's hosted contribution kind
 * (webhook event, import provider). Both seams recheck registration, capability
 * declaration, feature flag, operator grant, required env, and singleton scope
 * in the caller's transaction and audit denials/outcomes under a fixed
 * operation and reason taxonomy — differing only in the capability, the
 * operation and failure-reason literals, the definition lookup, and the
 * attribution error message. Each seam keeps its own thin `internalMutation`
 * wrapper (so its distinct, statically typed args stay visible to Convex
 * codegen) and delegates the decision here.
 */
export interface HostedContributionAuthorizationSpec {
	readonly capability: PluginCapability;
	readonly operation: HostedPluginOperation;
	readonly failureReasonCode: HostedPluginAuditReasonCode;
	/** Thrown by `recordHostedContributionOutcome` when attribution is invalid. */
	readonly attributionErrorMessage: string;
	/** Resolves a namespaced kind to its owning-plugin-tagged definition. */
	definitionFor(kind: string): { readonly pluginId: PluginId } | undefined;
}

/**
 * The plugin actor scope for `kind`, or `null` when the kind is unknown or the
 * requesting plugin does not own it (cross-plugin claim). Ownership is the only
 * thing this checks — capability/flag/grant/env are rechecked downstream.
 */
function matchingScope(
	spec: HostedContributionAuthorizationSpec,
	organizationId: string,
	pluginIdInput: string,
	kind: string
): HostedPluginActorScope | null {
	let pluginId: PluginId;
	try {
		pluginId = parsePluginId(pluginIdInput);
	} catch {
		return null;
	}
	const definition = spec.definitionFor(kind);
	if (!definition || definition.pluginId !== pluginId) return null;
	return Object.freeze({ organizationId, userId: SYSTEM_PLUGIN_ACTOR_ID, pluginId });
}

/** Rechecks ownership, registration, flag, grant, env, and singleton scope. */
export async function authorizeHostedContribution(
	ctx: MutationCtx,
	spec: HostedContributionAuthorizationSpec,
	pluginId: string,
	kind: string
): Promise<boolean> {
	const organizationId = await getSingletonOrganizationId(ctx).catch(() => null);
	if (!organizationId) return false;
	const auditScope = matchingScope(spec, organizationId, pluginId, kind);
	if (!auditScope) return false;
	if (await authorizeSystemBundledPlugin(ctx, auditScope.pluginId, spec.capability)) {
		return true;
	}
	await recordHostedPluginAudit(ctx, auditScope, spec.operation, 'denied', {
		reasonCode: 'access_denied',
	});
	return false;
}

/** Persists only trusted attribution, the outcome, and a bounded failure reason. */
export async function recordHostedContributionOutcome(
	ctx: MutationCtx,
	spec: HostedContributionAuthorizationSpec,
	pluginId: string,
	kind: string,
	outcome: 'completed' | 'failed'
): Promise<void> {
	const scope = matchingScope(spec, await getSingletonOrganizationId(ctx), pluginId, kind);
	if (!scope) throw new TypeError(spec.attributionErrorMessage);
	await recordHostedPluginAudit(
		ctx,
		scope,
		spec.operation,
		outcome,
		outcome === 'failed' ? { reasonCode: spec.failureReasonCode } : {}
	);
}
