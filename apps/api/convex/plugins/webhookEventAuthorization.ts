import { parsePluginId, PLUGIN_WEBHOOK_EVENT_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { recordHostedPluginAudit } from './audit';
import {
	authorizeSystemBundledPlugin,
	SYSTEM_PLUGIN_ACTOR_ID,
	type HostedPluginActorScope,
} from './authorization';
import { pluginWebhookEventDefinition } from './webhookEventCatalog';

/**
 * Runtime authorization seam for plugin-published webhook events. A plugin
 * publish call site (automation step / cron, later pieces) calls
 * `authorizePublish` in the same transaction as the delivery it schedules; the
 * event data a plugin produces is untrusted and must be clamped and scrubbed by
 * the host before it is delivered. This module only decides whether the plugin
 * may publish the requested namespaced kind at all.
 */
function matchingScope(
	organizationId: string,
	pluginIdInput: string,
	eventKind: string
): HostedPluginActorScope | null {
	let pluginId;
	try {
		pluginId = parsePluginId(pluginIdInput);
	} catch {
		return null;
	}
	const definition = pluginWebhookEventDefinition(eventKind);
	if (!definition || definition.pluginId !== pluginId) return null;
	return Object.freeze({ organizationId, userId: SYSTEM_PLUGIN_ACTOR_ID, pluginId });
}

/** Rechecks registration, flag, grant, env, and singleton scope before a publish. */
export const authorizePublish = internalMutation({
	args: { pluginId: v.string(), eventKind: v.string() },
	handler: async (ctx, args): Promise<boolean> => {
		const organizationId = await getSingletonOrganizationId(ctx).catch(() => null);
		if (!organizationId) return false;
		const auditScope = matchingScope(organizationId, args.pluginId, args.eventKind);
		if (!auditScope) return false;
		if (
			await authorizeSystemBundledPlugin(ctx, auditScope.pluginId, PLUGIN_WEBHOOK_EVENT_CAPABILITY)
		) {
			return true;
		}
		await recordHostedPluginAudit(ctx, auditScope, 'webhook.publish', 'denied', {
			reasonCode: 'access_denied',
		});
		return false;
	},
});

export const recordOutcome = internalMutation({
	args: {
		pluginId: v.string(),
		eventKind: v.string(),
		outcome: v.union(v.literal('completed'), v.literal('failed')),
	},
	handler: async (ctx, args): Promise<void> => {
		const scope = matchingScope(
			await getSingletonOrganizationId(ctx),
			args.pluginId,
			args.eventKind
		);
		if (!scope) throw new TypeError('Invalid bundled webhook event attribution');
		await recordHostedPluginAudit(
			ctx,
			scope,
			'webhook.publish',
			args.outcome,
			args.outcome === 'failed' ? { reasonCode: 'webhook_publish_failed' } : {}
		);
	},
});
