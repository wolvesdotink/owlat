import { PLUGIN_DRAFT_STRATEGY_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { pluginDraftStrategyDefinition } from './draftStrategyCatalog';
import {
	authorizeHostedContribution,
	recordHostedContributionOutcome,
	type HostedContributionAuthorizationSpec,
} from './hostedContributionAuthorization';

/**
 * Runtime authorization seam for plugin-contributed draft strategies. A denial
 * falls the host back to the built-in `default` strategy rather than failing the
 * draft, so the recheck is safe to run on every draft.
 */
const SPEC: HostedContributionAuthorizationSpec = {
	capability: PLUGIN_DRAFT_STRATEGY_CAPABILITY,
	operation: 'draft.strategy',
	failureReasonCode: 'draft_strategy_failed',
	attributionErrorMessage: 'Invalid bundled draft strategy attribution',
	definitionFor: pluginDraftStrategyDefinition,
};

export const authorizeExecution = internalMutation({
	args: { pluginId: v.string(), strategyKind: v.string() },
	handler: (ctx, args): Promise<boolean> =>
		authorizeHostedContribution(ctx, SPEC, args.pluginId, args.strategyKind),
});

export const recordOutcome = internalMutation({
	args: {
		pluginId: v.string(),
		strategyKind: v.string(),
		outcome: v.union(v.literal('completed'), v.literal('failed')),
		reasonCode: v.optional(
			v.union(
				v.literal('draft_strategy_failed'),
				v.literal('draft_strategy_invalid'),
				v.literal('draft_strategy_timeout')
			)
		),
	},
	handler: (ctx, args): Promise<void> =>
		recordHostedContributionOutcome(
			ctx,
			SPEC,
			args.pluginId,
			args.strategyKind,
			args.outcome,
			args.reasonCode
		),
});
