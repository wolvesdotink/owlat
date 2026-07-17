/**
 * Host-mediated scoped storage for a connected app (Tier 2).
 *
 * A connected app is the external half of a bundled plugin, so its host-mediated
 * KV IS that plugin's scoped storage — the `pluginStorage` namespace keyed by
 * (organizationId, pluginId), per the architecture's Tier-2 storage model. This
 * binder authenticates the app RECORD (not a user session): it resolves the
 * app's own tenant and bound plugin, confirms the app is enabled, and returns
 * the same scope-checked KV service bundled plugins use. Because the scope is
 * fixed to the app's stored organizationId and pluginId and is absent from every
 * returned method, tenant isolation and cross-plugin isolation are structural —
 * an app can only ever touch its own tenant's, its own plugin's namespace.
 *
 * Every capability call re-composes the restrict-only ceiling: the operator's
 * plugin-level grant AND the app's own requested grant must both include the
 * capability. Either one missing denies. An app can only narrow what the
 * operator allowed the plugin, never widen it.
 */

import type { PluginCapability, PluginId, PluginStorageService } from '@owlat/plugin-kit';
import { parsePluginId } from '@owlat/plugin-kit';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import {
	isBundledPluginCapabilityGranted,
	type HostedPluginActorScope,
} from '../plugins/authorization';
import { createScopedPluginStorageService, PluginStorageError } from '../plugins/storage';
import { loadConnectedAppInOrg } from './repository';

/** Audit/attribution actor id for a connected app's host-mediated storage calls. */
function connectedAppActorId(connectedAppId: Id<'connectedApps'>): string {
	return `connected_app:${connectedAppId}`;
}

/**
 * Authenticate a connected app by record and return its scoped KV service.
 * Throws {@link PluginStorageError} `access_denied` for a missing/foreign-tenant
 * app, a non-enabled app, or an unparseable bound plugin id. The `organizationId`
 * is the app's own tenant — the caller supplies it (in production, derived from
 * the verified plugin-bound key) so a cross-tenant id resolves to nothing.
 */
export async function bindConnectedAppStorage(
	ctx: MutationCtx,
	connectedAppId: Id<'connectedApps'>,
	organizationId: string
): Promise<PluginStorageService> {
	const app = await loadConnectedAppInOrg(ctx, connectedAppId, organizationId).catch(() => null);
	if (!app || app.status !== 'enabled') {
		throw new PluginStorageError('access_denied');
	}
	let pluginId: PluginId;
	try {
		pluginId = parsePluginId(app.pluginId);
	} catch {
		throw new PluginStorageError('access_denied');
	}
	const scope: HostedPluginActorScope = Object.freeze({
		organizationId: app.organizationId,
		userId: connectedAppActorId(connectedAppId),
		pluginId,
	});
	return createScopedPluginStorageService(ctx, scope, (capability) =>
		authorizeConnectedAppStorage(ctx, connectedAppId, organizationId, pluginId, capability)
	);
}

/**
 * Re-check, on every storage operation, that the app is still enabled and that
 * BOTH the app's own grant and the operator's plugin-level grant include the
 * capability. Reloading each time means a mid-session disable, revoke, or grant
 * removal takes effect immediately and fails closed.
 */
async function authorizeConnectedAppStorage(
	ctx: MutationCtx,
	connectedAppId: Id<'connectedApps'>,
	organizationId: string,
	pluginId: PluginId,
	capability: PluginCapability
): Promise<void> {
	const app = await loadConnectedAppInOrg(ctx, connectedAppId, organizationId).catch(() => null);
	if (
		!app ||
		app.status !== 'enabled' ||
		app.pluginId !== pluginId ||
		!app.grantedCapabilities.includes(capability) ||
		!(await isBundledPluginCapabilityGranted(ctx, pluginId, capability))
	) {
		throw new PluginStorageError('access_denied');
	}
}
