import { parsePluginId, PLUGIN_SEND_TRANSPORT_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { sendProviderCatalogEntry, isSendProviderKind } from '../lib/sendProviders/catalog';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { recordHostedPluginAudit } from './audit';
import {
	authorizeSystemBundledPlugin,
	SYSTEM_PLUGIN_ACTOR_ID,
	type HostedPluginActorScope,
} from './authorization';

function matchingPluginScope(
	organizationId: string,
	pluginIdInput: string,
	providerKind: string
): HostedPluginActorScope | null {
	if (!isSendProviderKind(providerKind)) return null;
	const entry = sendProviderCatalogEntry(providerKind);
	if (!entry.pluginId) return null;
	let pluginId;
	try {
		pluginId = parsePluginId(pluginIdInput);
	} catch {
		return null;
	}
	if (entry.pluginId !== pluginId) return null;
	return Object.freeze({ organizationId, userId: SYSTEM_PLUGIN_ACTOR_ID, pluginId });
}

/** Rechecks flag, grant, environment, and singleton scope just before an attempt. */
export const authorizeAttempt = internalMutation({
	args: { pluginId: v.string(), providerKind: v.string(), priorAttempts: v.number() },
	handler: async (ctx, args): Promise<boolean> => {
		if (!Number.isSafeInteger(args.priorAttempts) || args.priorAttempts < 0) return false;
		const organizationId = await getSingletonOrganizationId(ctx).catch(() => null);
		if (!organizationId) return false;
		const auditScope = matchingPluginScope(organizationId, args.pluginId, args.providerKind);
		if (!auditScope) return false;
		const scope = await authorizeSystemBundledPlugin(
			ctx,
			auditScope.pluginId,
			PLUGIN_SEND_TRANSPORT_CAPABILITY
		);
		if (scope) return true;
		await recordHostedPluginAudit(ctx, auditScope, 'transport.send', 'denied', {
			attempts: args.priorAttempts,
			reasonCode: 'access_denied',
		});
		return false;
	},
});

/** Persists only attribution, outcome, and attempt count after terminal dispatch. */
export const recordOutcome = internalMutation({
	args: {
		pluginId: v.string(),
		providerKind: v.string(),
		attempts: v.number(),
		success: v.boolean(),
	},
	handler: async (ctx, args): Promise<void> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const scope = matchingPluginScope(organizationId, args.pluginId, args.providerKind);
		if (!scope) throw new TypeError('Invalid bundled send transport attribution');
		await recordHostedPluginAudit(
			ctx,
			scope,
			'transport.send',
			args.success ? 'completed' : 'failed',
			args.success
				? { attempts: args.attempts }
				: { attempts: args.attempts, reasonCode: 'provider_dispatch_failed' }
		);
	},
});
