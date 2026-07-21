import { PLUGIN_AUTOMATION_STEP_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { pluginStepCatalogEntry } from '../automations/steps/catalog';
import {
	authorizeHostedContribution,
	recordHostedContributionOutcome,
	type HostedContributionAuthorizationSpec,
} from './hostedContributionAuthorization';

/**
 * Runtime authorization seam for a bundled automation step, called from the step
 * walker (an action) just before it executes a plugin step. Fails closed: a
 * denied plugin step surfaces as a step failure, which the walker retries and
 * then cancels — a disabled or ungranted plugin can never silently run.
 */
const SPEC: HostedContributionAuthorizationSpec = {
	capability: PLUGIN_AUTOMATION_STEP_CAPABILITY,
	operation: 'automation.step',
	failureReasonCode: 'automation_step_failed',
	attributionErrorMessage: 'Invalid bundled automation step attribution',
	definitionFor: pluginStepCatalogEntry,
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
