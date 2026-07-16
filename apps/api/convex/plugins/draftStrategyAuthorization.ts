import { parsePluginId, PLUGIN_DRAFT_STRATEGY_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { recordHostedPluginAudit, type HostedPluginAuditReasonCode } from './audit';
import { authorizeSystemBundledPlugin, SYSTEM_PLUGIN_ACTOR_ID } from './authorization';
import { pluginDraftStrategyDefinition } from './draftStrategyCatalog';

function matchingScope(organizationId: string, pluginIdInput: string, strategyKind: string) {
	let pluginId;
	try {
		pluginId = parsePluginId(pluginIdInput);
	} catch {
		return null;
	}
	const definition = pluginDraftStrategyDefinition(strategyKind);
	if (!definition || definition.pluginId !== pluginId) return null;
	return Object.freeze({ organizationId, userId: SYSTEM_PLUGIN_ACTOR_ID, pluginId });
}

export const authorizeExecution = internalMutation({
	args: { pluginId: v.string(), strategyKind: v.string() },
	handler: async (ctx, args): Promise<boolean> => {
		const organizationId = await getSingletonOrganizationId(ctx).catch(() => null);
		if (!organizationId) return false;
		const auditScope = matchingScope(organizationId, args.pluginId, args.strategyKind);
		if (!auditScope) return false;
		if (
			await authorizeSystemBundledPlugin(ctx, auditScope.pluginId, PLUGIN_DRAFT_STRATEGY_CAPABILITY)
		)
			return true;
		await recordHostedPluginAudit(ctx, auditScope, 'draft.strategy', 'denied', {
			reasonCode: 'access_denied',
		});
		return false;
	},
});

export const recordOutcome = internalMutation({
	args: {
		pluginId: v.string(),
		strategyKind: v.string(),
		outcome: v.union(v.literal('completed'), v.literal('failed')),
		reasonCode: v.optional(
			v.union(
				v.literal('draft_strategy_failed'),
				v.literal('draft_strategy_invalid'),
				v.literal('draft_strategy_timeout')
			)
		),
	},
	handler: async (ctx, args): Promise<void> => {
		const scope = matchingScope(
			await getSingletonOrganizationId(ctx),
			args.pluginId,
			args.strategyKind
		);
		if (!scope) throw new TypeError('Invalid bundled draft strategy attribution');
		await recordHostedPluginAudit(
			ctx,
			scope,
			'draft.strategy',
			args.outcome,
			args.reasonCode ? { reasonCode: args.reasonCode as HostedPluginAuditReasonCode } : {}
		);
	},
});
