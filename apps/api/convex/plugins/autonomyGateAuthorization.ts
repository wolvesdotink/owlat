import { parsePluginId, PLUGIN_AUTONOMY_GATE_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { recordHostedPluginAudit, type HostedPluginAuditReasonCode } from './audit';
import {
	authorizeSystemBundledPlugin,
	SYSTEM_PLUGIN_ACTOR_ID,
	type HostedPluginActorScope,
} from './authorization';
import { pluginAutonomyGateDefinition } from './autonomyGateCatalog';

function matchingScope(
	organizationId: string,
	pluginIdInput: string,
	gateKind: string
): HostedPluginActorScope | null {
	let pluginId;
	try {
		pluginId = parsePluginId(pluginIdInput);
	} catch {
		return null;
	}
	const definition = pluginAutonomyGateDefinition(gateKind);
	if (!definition || definition.pluginId !== pluginId) return null;
	return Object.freeze({ organizationId, userId: SYSTEM_PLUGIN_ACTOR_ID, pluginId });
}

/** Rechecks registration, flag, grant, env, and singleton scope immediately before execution. */
export const authorizeExecution = internalMutation({
	args: { pluginId: v.string(), gateKind: v.string() },
	handler: async (ctx, args): Promise<boolean> => {
		const organizationId = await getSingletonOrganizationId(ctx).catch(() => null);
		if (!organizationId) return false;
		const auditScope = matchingScope(organizationId, args.pluginId, args.gateKind);
		if (!auditScope) return false;
		if (
			await authorizeSystemBundledPlugin(ctx, auditScope.pluginId, PLUGIN_AUTONOMY_GATE_CAPABILITY)
		) {
			return true;
		}
		await recordHostedPluginAudit(ctx, auditScope, 'autonomy.gate', 'denied', {
			reasonCode: 'access_denied',
		});
		return false;
	},
});

export const recordOutcome = internalMutation({
	args: {
		pluginId: v.string(),
		gateKind: v.string(),
		outcome: v.union(v.literal('completed'), v.literal('failed')),
		reasonCode: v.optional(
			v.union(
				v.literal('autonomy_gate_failed'),
				v.literal('autonomy_gate_invalid'),
				v.literal('autonomy_gate_timeout')
			)
		),
	},
	handler: async (ctx, args): Promise<void> => {
		const scope = matchingScope(
			await getSingletonOrganizationId(ctx),
			args.pluginId,
			args.gateKind
		);
		if (!scope) throw new TypeError('Invalid bundled autonomy gate attribution');
		await recordHostedPluginAudit(
			ctx,
			scope,
			'autonomy.gate',
			args.outcome,
			args.reasonCode ? { reasonCode: args.reasonCode as HostedPluginAuditReasonCode } : {}
		);
	},
});
