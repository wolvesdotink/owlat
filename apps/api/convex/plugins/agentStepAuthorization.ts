import { PLUGIN_AGENT_STEP_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { pluginAgentStepDefinition } from '../agent/steps/catalog';
import {
	authorizeHostedContribution,
	recordHostedContributionOutcome,
	type HostedContributionAuthorizationSpec,
} from './hostedContributionAuthorization';

/**
 * Runtime authorization seam for plugin-contributed agent lifecycle steps.
 * Rechecks immutable registration, the plugin flag, the `agent:step` grant,
 * required env, and singleton scope in the caller's transaction; a denial never
 * invokes plugin code and is audited as `access_denied`.
 */
const SPEC: HostedContributionAuthorizationSpec = {
	capability: PLUGIN_AGENT_STEP_CAPABILITY,
	operation: 'agent.step',
	failureReasonCode: 'agent_step_failed',
	attributionErrorMessage: 'Invalid bundled agent step attribution',
	definitionFor: pluginAgentStepDefinition,
};

export const authorizeExecution = internalMutation({
	args: { pluginId: v.string(), stepKind: v.string() },
	handler: (ctx, args): Promise<boolean> =>
		authorizeHostedContribution(ctx, SPEC, args.pluginId, args.stepKind),
});

export const recordOutcome = internalMutation({
	args: {
		pluginId: v.string(),
		stepKind: v.string(),
		outcome: v.union(v.literal('completed'), v.literal('failed')),
	},
	handler: (ctx, args): Promise<void> =>
		recordHostedContributionOutcome(ctx, SPEC, args.pluginId, args.stepKind, args.outcome),
});
