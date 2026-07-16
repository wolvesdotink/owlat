import { parsePluginId, PLUGIN_IMPORT_PROVIDER_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { recordHostedPluginAudit } from './audit';
import {
	authorizeSystemBundledPlugin,
	SYSTEM_PLUGIN_ACTOR_ID,
	type HostedPluginActorScope,
} from './authorization';
import { pluginImportProviderDefinition } from './importProviderCatalog';

/**
 * Runtime authorization seam for plugin-contributed import providers. The
 * import walker resolves a plugin provider kind through the host and calls
 * `authorizeStart` before opening a run; the provider's paged fetch runs only
 * while flag, grant, env and singleton scope hold.
 */
function matchingScope(
	organizationId: string,
	pluginIdInput: string,
	providerKind: string
): HostedPluginActorScope | null {
	let pluginId;
	try {
		pluginId = parsePluginId(pluginIdInput);
	} catch {
		return null;
	}
	const definition = pluginImportProviderDefinition(providerKind);
	if (!definition || definition.pluginId !== pluginId) return null;
	return Object.freeze({ organizationId, userId: SYSTEM_PLUGIN_ACTOR_ID, pluginId });
}

/** Rechecks registration, flag, grant, env, and singleton scope before a run. */
export const authorizeStart = internalMutation({
	args: { pluginId: v.string(), providerKind: v.string() },
	handler: async (ctx, args): Promise<boolean> => {
		const organizationId = await getSingletonOrganizationId(ctx).catch(() => null);
		if (!organizationId) return false;
		const auditScope = matchingScope(organizationId, args.pluginId, args.providerKind);
		if (!auditScope) return false;
		if (
			await authorizeSystemBundledPlugin(
				ctx,
				auditScope.pluginId,
				PLUGIN_IMPORT_PROVIDER_CAPABILITY
			)
		) {
			return true;
		}
		await recordHostedPluginAudit(ctx, auditScope, 'import.provider', 'denied', {
			reasonCode: 'access_denied',
		});
		return false;
	},
});

export const recordOutcome = internalMutation({
	args: {
		pluginId: v.string(),
		providerKind: v.string(),
		outcome: v.union(v.literal('completed'), v.literal('failed')),
	},
	handler: async (ctx, args): Promise<void> => {
		const scope = matchingScope(
			await getSingletonOrganizationId(ctx),
			args.pluginId,
			args.providerKind
		);
		if (!scope) throw new TypeError('Invalid bundled import provider attribution');
		await recordHostedPluginAudit(
			ctx,
			scope,
			'import.provider',
			args.outcome,
			args.outcome === 'failed' ? { reasonCode: 'import_provider_failed' } : {}
		);
	},
});
