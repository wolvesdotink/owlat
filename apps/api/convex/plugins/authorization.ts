import {
	parsePluginId,
	type PluginCapability,
	type PluginId,
	type PluginManifest,
} from '@owlat/plugin-kit';
import { resolveFlags } from '@owlat/shared/featureFlags';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { isEnvPresent } from '../lib/env';
import {
	getBetterAuthSessionWithRole,
	getSingletonOrganizationId,
} from '../lib/sessionOrganization';
import { FEATURE_FLAG_REGISTRY } from './featureFlagRegistry';
import { bundledPluginComposition } from './plugins.generated';

export class PluginAuthorizationError extends Error {
	constructor() {
		super('Plugin access denied');
		this.name = 'PluginAuthorizationError';
	}
}

export interface HostedPluginActorScope {
	readonly organizationId: string;
	readonly userId: string;
	readonly pluginId: PluginId;
}

export interface AuthorizedPluginScope extends HostedPluginActorScope {
	readonly manifest: PluginManifest;
}

export const SYSTEM_PLUGIN_ACTOR_ID = 'system:bundled_plugin';

export function getBundledPluginManifest(pluginId: PluginId): PluginManifest {
	const plugin = bundledPluginComposition.find((candidate) => candidate.manifest.id === pluginId);
	if (!plugin) throw new PluginAuthorizationError();
	return plugin.manifest;
}

/**
 * The per-request runtime facts a plugin authorization decision reads from the
 * instance settings singleton: whether the plugin's flag is enabled and the
 * operator's capability grants for it. Read fresh in the caller's transaction so
 * disabling the plugin or revoking a grant takes effect immediately. `manifest`
 * must be the resolved manifest for `pluginId`; a plugin whose manifest declares
 * no `flag` is never enabled.
 */
export interface PluginRuntimeFacts {
	readonly flagEnabled: boolean;
	readonly grants: Readonly<Record<string, boolean>> | undefined;
}

export async function loadPluginRuntimeFacts(
	ctx: QueryCtx | MutationCtx,
	pluginId: PluginId,
	manifest: PluginManifest
): Promise<PluginRuntimeFacts> {
	const flagKey = `plugin.${pluginId}` as const;
	const settings = await ctx.db.query('instanceSettings').first();
	const flags = resolveFlags(settings?.featureFlags ?? {}, { registry: FEATURE_FLAG_REGISTRY });
	return {
		flagEnabled: manifest.flag !== undefined && flags[flagKey] === true,
		grants: settings?.pluginCapabilityGrants?.[flagKey],
	};
}

/**
 * Resolve scope server-side and recheck the immutable declaration, runtime
 * enablement, and operator grant together in the caller's DB transaction.
 */
export async function requireAuthenticatedBundledPlugin(
	ctx: QueryCtx | MutationCtx,
	pluginIdInput: unknown,
	capability?: PluginCapability
): Promise<AuthorizedPluginScope> {
	let pluginId: PluginId;
	try {
		pluginId = parsePluginId(pluginIdInput);
	} catch {
		throw new PluginAuthorizationError();
	}
	const session = await getBetterAuthSessionWithRole(ctx).catch(() => null);
	if (!session?.activeOrganizationId || !session.role) throw new PluginAuthorizationError();

	const manifest = getBundledPluginManifest(pluginId);
	if (!manifest.flag) throw new PluginAuthorizationError();
	const { flagEnabled, grants } = await loadPluginRuntimeFacts(ctx, pluginId, manifest);
	if (!flagEnabled) throw new PluginAuthorizationError();
	if (
		capability !== undefined &&
		(!manifest.capabilities.includes(capability) || grants?.[capability] !== true)
	) {
		throw new PluginAuthorizationError();
	}

	return Object.freeze({
		organizationId: session.activeOrganizationId,
		userId: session.userId,
		pluginId,
		manifest,
	});
}

/**
 * Background-job authorization for a bundled plugin. This performs every
 * mutable DB check in the caller's transaction and returns null on denial.
 */
export async function authorizeSystemBundledPlugin(
	ctx: QueryCtx | MutationCtx,
	pluginIdInput: unknown,
	capability: PluginCapability
): Promise<AuthorizedPluginScope | null> {
	let pluginId: PluginId;
	try {
		pluginId = parsePluginId(pluginIdInput);
	} catch {
		return null;
	}

	let organizationId: string;
	let manifest: PluginManifest;
	try {
		organizationId = await getSingletonOrganizationId(ctx);
		manifest = getBundledPluginManifest(pluginId);
	} catch {
		return null;
	}
	if (!manifest.flag || !manifest.capabilities.includes(capability)) return null;

	const { flagEnabled, grants } = await loadPluginRuntimeFacts(ctx, pluginId, manifest);
	if (
		!flagEnabled ||
		grants?.[capability] !== true ||
		!(manifest.flag.requiredEnvVars ?? []).every(isEnvPresent)
	) {
		return null;
	}

	return Object.freeze({
		organizationId,
		userId: SYSTEM_PLUGIN_ACTOR_ID,
		pluginId,
		manifest,
	});
}
