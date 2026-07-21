import { PLUGIN_AUTONOMY_GATE_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { pluginAutonomyGateDefinition } from './autonomyGateCatalog';
import {
	authorizeHostedContribution,
	recordHostedContributionOutcome,
	type HostedContributionAuthorizationSpec,
} from './hostedContributionAuthorization';

/**
 * Runtime authorization seam for plugin-contributed autonomy (send) gates.
 * Fails CLOSED: a denied, disabled or ungranted gate leaves the host's own
 * caution objection in place, so the reply routes to human review.
 */
const SPEC: HostedContributionAuthorizationSpec = {
	capability: PLUGIN_AUTONOMY_GATE_CAPABILITY,
	operation: 'autonomy.gate',
	failureReasonCode: 'autonomy_gate_failed',
	attributionErrorMessage: 'Invalid bundled autonomy gate attribution',
	definitionFor: pluginAutonomyGateDefinition,
};

export const authorizeExecution = internalMutation({
	args: { pluginId: v.string(), gateKind: v.string() },
	handler: (ctx, args): Promise<boolean> =>
		authorizeHostedContribution(ctx, SPEC, args.pluginId, args.gateKind),
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
	handler: (ctx, args): Promise<void> =>
		recordHostedContributionOutcome(
			ctx,
			SPEC,
			args.pluginId,
			args.gateKind,
			args.outcome,
			args.reasonCode
		),
});
