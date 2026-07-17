import { PLUGIN_WEBHOOK_EVENT_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import {
	authorizeHostedContribution,
	recordHostedContributionOutcome,
	type HostedContributionAuthorizationSpec,
} from './hostedContributionAuthorization';
import { pluginWebhookEventDefinition } from './webhookEventCatalog';

/**
 * Runtime authorization seam for plugin-published webhook events. A plugin
 * publish call site (automation step / cron, later pieces) calls
 * `authorizePublish` in the same transaction as the delivery it schedules; the
 * event data a plugin produces is untrusted and must be clamped and scrubbed by
 * the host before it is delivered. This module only decides whether the plugin
 * may publish the requested namespaced kind at all.
 */
const SPEC: HostedContributionAuthorizationSpec = {
	capability: PLUGIN_WEBHOOK_EVENT_CAPABILITY,
	operation: 'webhook.publish',
	failureReasonCode: 'webhook_publish_failed',
	attributionErrorMessage: 'Invalid bundled webhook event attribution',
	definitionFor: pluginWebhookEventDefinition,
};

/** Rechecks registration, flag, grant, env, and singleton scope before a publish. */
export const authorizePublish = internalMutation({
	args: { pluginId: v.string(), eventKind: v.string() },
	handler: (ctx, args): Promise<boolean> =>
		authorizeHostedContribution(ctx, SPEC, args.pluginId, args.eventKind),
});

export const recordOutcome = internalMutation({
	args: {
		pluginId: v.string(),
		eventKind: v.string(),
		outcome: v.union(v.literal('completed'), v.literal('failed')),
	},
	handler: (ctx, args): Promise<void> =>
		recordHostedContributionOutcome(ctx, SPEC, args.pluginId, args.eventKind, args.outcome),
});
