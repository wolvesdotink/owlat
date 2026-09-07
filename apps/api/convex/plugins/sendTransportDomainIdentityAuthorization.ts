import { PLUGIN_SEND_TRANSPORT_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { pluginSendTransportDomainIdentityDefinition } from './sendTransportDomainIdentityCatalog';
import {
	authorizeHostedContribution,
	recordHostedContributionOutcome,
	type HostedContributionAuthorizationSpec,
} from './hostedContributionAuthorization';
import { completedOrFailedValidator } from '../lib/convexValidators';

/**
 * Runtime authorization seam for a bundled send transport's SENDING-DOMAIN
 * IDENTITY calls (the seams plan's P3.2) — the third sibling of
 * `sendTransportAuthorization` and `sendTransportWebhookAuthorization`.
 *
 * WHY IT IS ITS OWN SEAM rather than a reuse of the send one. The question is the
 * same (may this plugin's transport contribution act right now: registered, flag
 * on, `send:transport` granted, env present, singleton scope) but the ANSWER IS
 * AUDITED, and an identity registration recorded as `transport.send` would put a
 * provider call this deployment made ABOUT a customer's domain into the row that
 * means messages it sent.
 *
 * WHY IT IS CHECKED AT ALL, on work the host schedules rather than a plugin: the
 * call spends this deployment's credential at a third party and creates state
 * there under a customer's domain name. Turning a plugin off has to stop that,
 * and it has to be visible that it did.
 */
const SPEC: HostedContributionAuthorizationSpec = {
	capability: PLUGIN_SEND_TRANSPORT_CAPABILITY,
	operation: 'transport.domain_identity',
	// No new reason code: `provider_dispatch_failed` is already the taxonomy's
	// "this transport's dispatch did not complete", and an identity call that was
	// authentic and authorized and still failed is exactly that.
	failureReasonCode: 'provider_dispatch_failed',
	attributionErrorMessage: 'Invalid bundled send transport domain identity attribution',
	definitionFor: pluginSendTransportDomainIdentityDefinition,
};

/** Rechecks flag, grant, environment, and singleton scope before a provider call. */
export const authorizeIdentityCall = internalMutation({
	args: { pluginId: v.string(), transportKind: v.string() },
	handler: (ctx, args): Promise<boolean> =>
		authorizeHostedContribution(ctx, SPEC, args.pluginId, args.transportKind),
});

/** Persists only attribution and the outcome of an authorized identity call. */
export const recordOutcome = internalMutation({
	args: {
		pluginId: v.string(),
		transportKind: v.string(),
		outcome: completedOrFailedValidator,
	},
	handler: (ctx, args): Promise<void> =>
		recordHostedContributionOutcome(ctx, SPEC, args.pluginId, args.transportKind, args.outcome),
});
