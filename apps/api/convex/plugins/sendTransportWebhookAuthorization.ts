import { PLUGIN_SEND_TRANSPORT_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { pluginSendTransportWebhookDefinition } from './sendTransportWebhookCatalog';
import {
	authorizeHostedContribution,
	recordHostedContributionOutcome,
	type HostedContributionAuthorizationSpec,
} from './hostedContributionAuthorization';

/**
 * Runtime authorization seam for a bundled send transport's FEEDBACK deliveries
 * (the seams plan's D6/P2.2) — the inbound twin of `sendTransportAuthorization`.
 *
 * WHY IT IS ITS OWN SEAM rather than a reuse of the send one. The question is
 * the same (may this plugin's transport contribution act right now: registered,
 * flag on, `send:transport` granted, env present, singleton scope) but the
 * ANSWER IS AUDITED, and an inbound delivery recorded as `transport.send` would
 * put events the deployment received into the row that means messages it sent.
 * The operation literal is the only difference; the decision is the shared one.
 *
 * WHY IT IS CHECKED AT ALL on a route the provider, not the plugin, calls: a
 * disabled or revoked contribution must not keep writing to the delivery record
 * through an endpoint an operator cannot see. Turning a plugin off has to turn
 * off everything it does, in both directions.
 */
const SPEC: HostedContributionAuthorizationSpec = {
	capability: PLUGIN_SEND_TRANSPORT_CAPABILITY,
	operation: 'transport.feedback',
	// The inbound counterpart of a failed dispatch: the events were authentic and
	// authorized, and applying them failed. No new reason code — `provider_dispatch_failed`
	// is already the taxonomy's "this transport's dispatch did not complete".
	failureReasonCode: 'provider_dispatch_failed',
	attributionErrorMessage: 'Invalid bundled send transport feedback attribution',
	definitionFor: pluginSendTransportWebhookDefinition,
};

/** Rechecks flag, grant, environment, and singleton scope before events land. */
export const authorizeDelivery = internalMutation({
	args: { pluginId: v.string(), transportKind: v.string() },
	handler: (ctx, args): Promise<boolean> =>
		authorizeHostedContribution(ctx, SPEC, args.pluginId, args.transportKind),
});

/** Persists only attribution and the outcome of an authorized delivery. */
export const recordOutcome = internalMutation({
	args: {
		pluginId: v.string(),
		transportKind: v.string(),
		outcome: v.union(v.literal('completed'), v.literal('failed')),
	},
	handler: (ctx, args): Promise<void> =>
		recordHostedContributionOutcome(ctx, SPEC, args.pluginId, args.transportKind, args.outcome),
});
