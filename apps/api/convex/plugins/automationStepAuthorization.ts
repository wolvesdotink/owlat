import { parsePluginId, PLUGIN_AUTOMATION_STEP_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { pluginStepCatalogEntry } from '../automations/steps/catalog';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { recordHostedPluginAudit } from './audit';
import {
	authorizeSystemBundledPlugin,
	SYSTEM_PLUGIN_ACTOR_ID,
	type HostedPluginActorScope,
} from './authorization';

/**
 * Runtime authorization for a bundled automation step, called from the step
 * walker (an action) just before it executes a plugin step. Rechecks immutable
 * registration, the plugin flag, the automation:step capability grant, required
 * env vars, and singleton-org scope in one transaction. Fails closed: a denied
 * plugin step surfaces as a step failure, which the walker retries and then
 * cancels — a disabled or ungranted plugin can never silently run.
 */
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
	const entry = pluginStepCatalogEntry(stepKind);
	if (!entry || entry.pluginId !== pluginId) return null;
	return Object.freeze({ organizationId, userId: SYSTEM_PLUGIN_ACTOR_ID, pluginId });
}

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
			PLUGIN_AUTOMATION_STEP_CAPABILITY
		);
		if (scope) return true;
		await recordHostedPluginAudit(ctx, auditScope, 'automation.step', 'denied', {
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
		if (!scope) throw new TypeError('Invalid bundled automation step attribution');
		await recordHostedPluginAudit(
			ctx,
			scope,
			'automation.step',
			args.success ? 'completed' : 'failed',
			args.success ? {} : { reasonCode: 'automation_step_failed' }
		);
	},
});
