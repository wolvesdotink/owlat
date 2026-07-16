import { parsePluginId, PLUGIN_CRON_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { recordHostedPluginAudit, type HostedPluginAuditReasonCode } from './audit';
import {
	authorizeSystemBundledPlugin,
	SYSTEM_PLUGIN_ACTOR_ID,
	type HostedPluginActorScope,
} from './authorization';
import { pluginCronDefinition } from './cronCatalog';

function matchingScope(
	organizationId: string,
	pluginIdInput: string,
	cronKind: string
): HostedPluginActorScope | null {
	let pluginId;
	try {
		pluginId = parsePluginId(pluginIdInput);
	} catch {
		return null;
	}
	const definition = pluginCronDefinition(cronKind);
	if (!definition || definition.pluginId !== pluginId) return null;
	return Object.freeze({ organizationId, userId: SYSTEM_PLUGIN_ACTOR_ID, pluginId });
}

/**
 * Rechecks registration, flag, grant, env, and singleton scope inside the
 * caller's transaction immediately before a cron tick runs. Returns false —
 * never throws — for a disabled, ungranted, misconfigured, or uninstalled
 * plugin so the wrapping cron action no-ops instead of erroring.
 */
export const authorizeExecution = internalMutation({
	args: { pluginId: v.string(), cronKind: v.string() },
	handler: async (ctx, args): Promise<boolean> => {
		const organizationId = await getSingletonOrganizationId(ctx).catch(() => null);
		if (!organizationId) return false;
		const auditScope = matchingScope(organizationId, args.pluginId, args.cronKind);
		if (!auditScope) return false;
		if (await authorizeSystemBundledPlugin(ctx, auditScope.pluginId, PLUGIN_CRON_CAPABILITY)) {
			return true;
		}
		await recordHostedPluginAudit(ctx, auditScope, 'cron.run', 'denied', {
			reasonCode: 'access_denied',
		});
		return false;
	},
});

export const recordOutcome = internalMutation({
	args: {
		pluginId: v.string(),
		cronKind: v.string(),
		outcome: v.union(v.literal('completed'), v.literal('failed')),
		reasonCode: v.optional(
			v.union(v.literal('cron_failed'), v.literal('cron_invalid'), v.literal('cron_timeout'))
		),
	},
	handler: async (ctx, args): Promise<void> => {
		const scope = matchingScope(
			await getSingletonOrganizationId(ctx),
			args.pluginId,
			args.cronKind
		);
		if (!scope) throw new TypeError('Invalid bundled cron attribution');
		await recordHostedPluginAudit(
			ctx,
			scope,
			'cron.run',
			args.outcome,
			args.reasonCode ? { reasonCode: args.reasonCode as HostedPluginAuditReasonCode } : {}
		);
	},
});
