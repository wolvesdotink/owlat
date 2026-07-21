import { PLUGIN_CRON_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import {
	authorizeHostedContribution,
	recordHostedContributionOutcome,
	type HostedContributionAuthorizationSpec,
} from './hostedContributionAuthorization';
import { pluginCronDefinition } from './cronCatalog';

/**
 * Runtime authorization seam for plugin-contributed crons. The host cron
 * wrapper rechecks registration, capability declaration, feature flag, operator
 * grant, required env, and singleton scope inside its own tick transaction —
 * failing closed, never throwing — so a disabled, ungranted, misconfigured, or
 * uninstalled plugin no-ops instead of erroring or looping.
 */
const SPEC: HostedContributionAuthorizationSpec = {
	capability: PLUGIN_CRON_CAPABILITY,
	operation: 'cron.run',
	failureReasonCode: 'cron_failed',
	attributionErrorMessage: 'Invalid bundled cron attribution',
	definitionFor: pluginCronDefinition,
};

/** Rechecks registration, flag, grant, env, and singleton scope before a tick. */
export const authorizeExecution = internalMutation({
	args: { pluginId: v.string(), cronKind: v.string() },
	handler: (ctx, args): Promise<boolean> =>
		authorizeHostedContribution(ctx, SPEC, args.pluginId, args.cronKind),
});

export const recordOutcome = internalMutation({
	args: {
		pluginId: v.string(),
		cronKind: v.string(),
		outcome: v.union(v.literal('completed'), v.literal('failed')),
		reasonCode: v.optional(
			v.union(v.literal('cron_failed'), v.literal('cron_invalid'), v.literal('cron_timeout'))
		),
	},
	handler: (ctx, args): Promise<void> =>
		recordHostedContributionOutcome(
			ctx,
			SPEC,
			args.pluginId,
			args.cronKind,
			args.outcome,
			args.reasonCode
		),
});
