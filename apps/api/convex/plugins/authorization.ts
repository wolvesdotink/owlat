import { parsePluginId, type PluginCapability, type PluginId, type PluginManifest } from '@owlat/plugin-kit';
import { resolveFlags } from '@owlat/shared/featureFlags';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { FEATURE_FLAG_REGISTRY } from './featureFlagRegistry';
import { bundledPluginComposition } from './plugins.generated';

export class PluginAuthorizationError extends Error {
	constructor() {
		super('Plugin access denied');
		this.name = 'PluginAuthorizationError';
	}
}

export interface AuthorizedPluginScope {
	readonly organizationId: string;
	readonly userId: string;
	readonly pluginId: PluginId;
	readonly manifest: PluginManifest;
}

export function getBundledPluginManifest(pluginId: PluginId): PluginManifest {
	const plugin = bundledPluginComposition.find((candidate) => candidate.manifest.id === pluginId);
	if (!plugin) throw new PluginAuthorizationError();
	return plugin.manifest;
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
	const flagKey = `plugin.${pluginId}` as const;
	const settings = await ctx.db.query('instanceSettings').first();
	const flags = resolveFlags(settings?.featureFlags ?? {}, { registry: FEATURE_FLAG_REGISTRY });
	if (flags[flagKey] !== true) throw new PluginAuthorizationError();
	if (
		capability !== undefined &&
		(!manifest.capabilities.includes(capability) ||
			settings?.pluginCapabilityGrants?.[flagKey]?.[capability] !== true)
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
