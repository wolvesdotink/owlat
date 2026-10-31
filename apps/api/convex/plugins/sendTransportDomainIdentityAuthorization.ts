import { PLUGIN_SEND_TRANSPORT_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalQuery, type MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { pluginSendTransportDomainIdentityDefinition } from './sendTransportDomainIdentityCatalog';
import {
	authorizeHostedContribution,
	isHostedContributionAuthorized,
	recordHostedContributionOutcome,
	type HostedContributionAuthorizationSpec,
} from './hostedContributionAuthorization';
import { completedOrFailedValidator } from '../lib/literalValidators';

/**
 * Runtime authorization seam for a bundled send transport's SENDING-DOMAIN
 * IDENTITY calls — the third sibling of
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

/**
 * Whether an identity call may be made now: flag, grant, environment, and
 * singleton scope, read without writing. The identity action asks this before
 * its provider call; a refusal is audited by the commit that defers the row
 * (`authorizeIdentityCallIn`, inside `domains/pluginRelayMutations.ts`).
 */
export const checkIdentityCall = internalQuery({
	args: { pluginId: v.string(), transportKind: v.string() },
	handler: (ctx, args): Promise<boolean> =>
		isHostedContributionAuthorized(ctx, SPEC, args.pluginId, args.transportKind),
});

/** Rechecks the identity call's authorization in the caller's transaction, auditing a denial. */
export function authorizeIdentityCallIn(
	ctx: MutationCtx,
	pluginId: string,
	transportKind: string
): Promise<boolean> {
	return authorizeHostedContribution(ctx, SPEC, pluginId, transportKind);
}

/** Audits the outcome of an identity call in the caller's transaction. */
export function recordIdentityCallOutcome(
	ctx: MutationCtx,
	pluginId: string,
	transportKind: string,
	outcome: 'completed' | 'failed'
): Promise<void> {
	return recordHostedContributionOutcome(ctx, SPEC, pluginId, transportKind, outcome);
}

/**
 * Rechecks flag, grant, environment, and singleton scope before a provider call.
 * Kept for one release: identity actions of the previous release still call it
 * by path during the deploy. Remove after release 0.6.17.
 */
export const authorizeIdentityCall = internalMutation({
	args: { pluginId: v.string(), transportKind: v.string() },
	handler: (ctx, args): Promise<boolean> =>
		authorizeIdentityCallIn(ctx, args.pluginId, args.transportKind),
});

/**
 * Persists only attribution and the outcome of an authorized identity call.
 * Kept for one release, like `authorizeIdentityCall`. Remove after release 0.6.17.
 */
export const recordOutcome = internalMutation({
	args: {
		pluginId: v.string(),
		transportKind: v.string(),
		outcome: completedOrFailedValidator,
	},
	handler: (ctx, args): Promise<void> =>
		recordIdentityCallOutcome(ctx, args.pluginId, args.transportKind, args.outcome),
});
