import { parsePluginId, PLUGIN_AGENT_STEP_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { pluginAgentStepDefinition } from '../agent/steps/catalog';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { recordHostedPluginAudit } from './audit';
import {
	authorizeSystemBundledPlugin,
	SYSTEM_PLUGIN_ACTOR_ID,
	type HostedPluginActorScope,
} from './authorization';

function matchingScope(
	organizationId: string,
	pluginIdInput: string,
	stepKind: string
): HostedPluginActorScope | null {
	let pluginId;
	try {
		pluginId = parsePluginId(pluginIdInput);
	} catch {
		return null;
	}
	const definition = pluginAgentStepDefinition(stepKind);
	if (!definition || definition.pluginId !== pluginId) return null;
	return Object.freeze({ organizationId, userId: SYSTEM_PLUGIN_ACTOR_ID, pluginId });
}

/** Rechecks immutable registration, flag, grant, env, and singleton scope before execution. */
export const authorizeExecution = internalMutation({
	args: { pluginId: v.string(), stepKind: v.string() },
	handler: async (ctx, args): Promise<boolean> => {
		const organizationId = await getSingletonOrganizationId(ctx).catch(() => null);
		if (!organizationId) return false;
		const auditScope = matchingScope(organizationId, args.pluginId, args.stepKind);
		if (!auditScope) return false;
		const scope = await authorizeSystemBundledPlugin(
			ctx,
			auditScope.pluginId,
			PLUGIN_AGENT_STEP_CAPABILITY
		);
		if (scope) return true;
		await recordHostedPluginAudit(ctx, auditScope, 'agent.step', 'denied', {
			reasonCode: 'access_denied',
		});
		return false;
	},
});

export const recordOutcome = internalMutation({
	args: { pluginId: v.string(), stepKind: v.string(), success: v.boolean() },
	handler: async (ctx, args): Promise<void> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const scope = matchingScope(organizationId, args.pluginId, args.stepKind);
		if (!scope) throw new TypeError('Invalid bundled agent step attribution');
		await recordHostedPluginAudit(
			ctx,
			scope,
			'agent.step',
			args.success ? 'completed' : 'failed',
			args.success ? {} : { reasonCode: 'agent_step_failed' }
		);
	},
});
